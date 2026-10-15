import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
	ChannelAck,
	ChannelAttachment,
	ChannelContext,
	ChannelHealth,
	ChannelInboundEvent,
	ChannelInteractionResponse,
	ChannelOutboundMessage,
} from "@acpantenna/channel";
import { attachmentNotice, createTextInboundEvent } from "@acpantenna/channel";
import {
	ClientEvent,
	createClient,
	EventType,
	HttpApiEvent,
	type MatrixClient,
	type MatrixEvent,
	MatrixEventEvent,
	MatrixScheduler,
	PendingEventOrdering,
	RelationType,
	type Room,
	RoomEvent,
	RoomMemberEvent,
	SyncState,
} from "matrix-js-sdk";
import {
	CryptoEvent,
	VerificationPhase,
	type VerificationRequest,
	VerificationRequestEvent,
	VerifierEvent,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { DEFAULT_DEVICE_NAME, type MatrixChannelConfig } from "./config.ts";
import {
	PrivateFile,
	passwordLogin,
	type StoredSession,
} from "./credentials.ts";
import {
	CrossSigningApprovalNeeded,
	crossSigningAuth,
	ensureCrossSigning,
} from "./cross-signing.ts";
import { CryptoStoreFile } from "./crypto-store.ts";
import { provideCryptoWasm, releaseCryptoWasm } from "./crypto-wasm.ts";
import { MatrixSetupError } from "./errors.ts";
import { escapeHtml } from "./format.ts";
import { discoverBaseUrl } from "./homeserver.ts";
import {
	describeMatrixError,
	hostOf,
	isSenderAllowed,
	stripReplyFallback,
} from "./inbound.ts";
import {
	answerFromReaction,
	answerFromText,
	createPendingInteraction,
	describeAnswer,
	type PendingInteraction,
	reactionKeys,
	renderInteraction,
} from "./interactions.ts";
import {
	editContent,
	type LiveMessageTransport,
	type MessageContent,
} from "./live-message.ts";
import {
	encryptAttachment,
	imageDimensions,
	isTooLarge,
	mediaContent,
	uploadLimitProblem,
} from "./media.ts";
import { RoomOutbox, replyContent } from "./outbox.ts";
import { RateLimitedError, withRateLimitRetry } from "./rate-limit.ts";
import { setSdkLogSink } from "./sdk-logs.ts";

const FIRST_SEND_DELAY_MS = 400;
const PROCESSED_MEMORY = 500;
const DECRYPTION_GRACE_MS = 30_000;
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Under MAS an approved reset is open for 10 minutes; try well within that. */
const CROSS_SIGNING_RETRY_MS = 5 * 60_000;

export { MatrixSetupError };

/** The bot's own secret-storage key, as kept in its state dir. */
interface StoredSecretStorageKey {
	userId: string;
	keyId: string;
	/** base64 */
	key: string;
}

type HealthState = ChannelHealth["state"];

/**
 * One bot account on one homeserver: login check, encryption, sync, and the
 * translation between Matrix rooms and gateway conversations.
 */
export class MatrixRuntime {
	private client?: MatrixClient;
	private cryptoStore?: CryptoStoreFile;
	private userId: string;
	/** Where the client API is: the configured URL, or what its well-known names. */
	private baseUrl?: string;
	private deviceId?: string;
	/** The token in use: the configured one, or a password login's. */
	private accessToken?: string;
	private secretStorageKey?: StoredSecretStorageKey;
	private crossSigningTimer?: ReturnType<typeof setTimeout>;
	private approvalUrlLogged?: string;
	private startedAt = 0;
	private stopping = false;
	private prepared = false;
	private healthState: HealthState = "starting";
	private healthMessage?: string;
	private reconnectAttempt = 0;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private readonly outboxes = new Map<string, RoomOutbox>();
	/**
	 * The homeserver's upload limit (`m.upload.size`), asked once. Null when
	 * it states none; unset until the first file.
	 */
	private uploadLimit?: Promise<number | null>;
	private readonly pending = new Map<string, Map<string, PendingInteraction>>();
	private readonly processed = new Set<string>();
	private readonly awaitingDecryption = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private readonly inboundChains = new Map<string, Promise<void>>();
	/** What each pending prompt shows, to edit the answer into it. */
	private readonly prompts = new Map<string, Omit<MessageContent, "msgtype">>();
	/**
	 * Verifications in progress. matrix-js-sdk holds a request only weakly
	 * (the Rust side calls back through a WeakRef), so one nothing else
	 * references can be collected mid-way and never see the other side's
	 * `start`; the person's client then times out.
	 */
	private readonly verifications = new Set<VerificationRequest>();

	public constructor(
		private readonly config: MatrixChannelConfig,
		private readonly context: ChannelContext<unknown>,
	) {
		this.userId = config.userId;
		setSdkLogSink((level, args) => {
			context.logger.warn(`matrix-js-sdk ${level}`, {
				message: args.map((arg) => String(arg)).join(" "),
			});
		});
	}

	public get homeserverUrl(): string {
		return this.config.homeserverUrl ?? "https://matrix.org";
	}

	private get streaming(): boolean {
		const mode = this.config.delivery?.mode;
		return mode === "streamChunks" || mode === "debounceChunks";
	}

	public health(): ChannelHealth {
		return {
			state: this.healthState,
			...(this.healthMessage ? { message: this.healthMessage } : {}),
			checkedAt: new Date().toISOString(),
		};
	}

	/**
	 * Check the token and start syncing. A token the server rejects, or one
	 * for another account, fails here; a homeserver that can't be reached is
	 * retried in the background while health() says so.
	 */
	public async start(): Promise<void> {
		this.startedAt = Date.now();

		try {
			await this.connect();
		} catch (error) {
			if (error instanceof MatrixSetupError) {
				this.setHealth("stopped", error.message);
				throw error;
			}

			this.setHealth(
				"degraded",
				describeMatrixError(error, this.homeserverUrl),
			);
			this.scheduleReconnect();
		}
	}

	public async stop(): Promise<void> {
		this.stopping = true;
		clearTimeout(this.reconnectTimer);
		clearTimeout(this.crossSigningTimer);

		for (const timer of this.awaitingDecryption.values()) {
			clearTimeout(timer);
		}

		await Promise.race([
			Promise.all(
				[...this.outboxes.values()].map((outbox) => outbox.endTurn()),
			),
			Bun.sleep(5_000),
		]);
		this.client?.stopClient();
		await this.cryptoStore?.close();
		this.setHealth("stopped");
	}

	public async send(message: ChannelOutboundMessage): Promise<ChannelAck> {
		const client = this.client;
		const roomId = message.conversationId;

		if (!client || !this.prepared) {
			return {
				ok: false,
				retryAfterMs: 5_000,
				error: this.healthMessage ?? "The Matrix channel is still connecting.",
			};
		}

		if (client.getRoom(roomId)?.getMyMembership() !== "join") {
			// Sending to a room the SDK does not know would skip encryption.
			return { ok: false, error: `The bot is not in room ${roomId}.` };
		}

		const outbox = this.outbox(roomId);

		try {
			if (message.interaction) {
				const content = renderInteraction(
					message.text ?? "",
					message.interaction,
				);
				const eventId = await outbox.send(
					{ msgtype: "m.text", ...content },
					message.id,
				);
				this.trackInteraction(roomId, eventId, message, content);
				return { ok: true, messageId: eventId };
			}

			if (message.attachment) {
				return await this.sendAttachment(
					roomId,
					outbox,
					message.attachment,
					message.id,
				);
			}

			if (message.event?.type === "toolCall") {
				outbox.toolCall(message.event.toolCall);
				return { ok: true, messageId: message.id };
			}

			if (message.event || !message.text) {
				// Thoughts are not shown; other events have nothing to render.
				return { ok: true, messageId: message.id };
			}

			if (message.origin === "turn" && this.streaming) {
				outbox.appendReply(message.text, message.id);
				return { ok: true, messageId: message.id };
			}

			const eventId = await outbox.send(replyContent(message.text), message.id);
			return { ok: true, messageId: eventId };
		} catch (error) {
			return this.failedAck(error);
		}
	}

	/**
	 * Upload a file and post it. A file the homeserver will not take is not
	 * a delivery failure to retry: the room is told why, in a notice, and the
	 * send counts as done, because the person waiting has been answered.
	 */
	private async sendAttachment(
		roomId: string,
		outbox: RoomOutbox,
		attachment: ChannelAttachment,
		txnId: string | undefined,
	): Promise<ChannelAck> {
		const client = this.requireClient();
		const host = hostOf(this.homeserverUrl);
		const refuse = async (reason: string) => {
			this.context.logger.warn("A file was not sent to Matrix.", {
				roomId,
				name: attachment.name,
				size: attachment.size,
				reason,
			});
			const eventId = await outbox.send(
				{ msgtype: "m.notice", body: attachmentNotice(attachment, reason) },
				txnId,
			);
			return { ok: true, messageId: eventId };
		};

		// Checked before the file is read: a 2 GB video is refused without
		// being loaded into memory first.
		const tooLarge = uploadLimitProblem(
			attachment.size,
			(await this.mediaUploadLimit()) ?? undefined,
			host,
		);

		if (tooLarge) {
			return refuse(tooLarge);
		}

		const bytes =
			attachment.data ?? (await Bun.file(attachment.path ?? "").bytes());
		const encrypted =
			(await client.getCrypto()?.isEncryptionEnabledInRoom(roomId)) ?? false;
		const dimensions =
			attachment.kind === "image" ? imageDimensions(bytes) : undefined;

		try {
			let content: ReturnType<typeof mediaContent>;

			if (encrypted) {
				// The server stores ciphertext, so it is given no name and no
				// type: both would say what the room is passing around.
				const { data, file } = await encryptAttachment(bytes);
				const uploaded = await client.uploadContent(data, {
					type: "application/octet-stream",
					includeFilename: false,
				});
				content = mediaContent(
					attachment,
					{ file: { ...file, url: uploaded.content_uri } },
					dimensions,
				);
			} else {
				const uploaded = await client.uploadContent(bytes, {
					name: attachment.name,
					type: attachment.mimeType,
				});
				content = mediaContent(
					attachment,
					{ url: uploaded.content_uri },
					dimensions,
				);
			}

			const eventId = await outbox.send(content, txnId);
			return { ok: true, messageId: eventId };
		} catch (error) {
			if (isTooLarge(error)) {
				return refuse(`${host} refused it as too large.`);
			}

			return this.failedAck(error);
		}
	}

	/** `m.upload.size`, from the authenticated endpoint or the legacy one. */
	private mediaUploadLimit(): Promise<number | null> {
		this.uploadLimit ??= (async () => {
			const client = this.requireClient();

			for (const authenticated of [true, false]) {
				try {
					const config = await client.getMediaConfig(authenticated);
					const size = config["m.upload.size"];
					return typeof size === "number" && size > 0 ? size : null;
				} catch {
					// A server without the v1 endpoint (before spec v1.11)
					// answers the legacy one.
				}
			}

			// Unknown is not a limit of zero. The upload's own refusal is
			// caught instead (isTooLarge).
			this.uploadLimit = undefined;
			return null;
		})();

		return this.uploadLimit;
	}

	private failedAck(error: unknown): ChannelAck {
		if (error instanceof RateLimitedError) {
			return {
				ok: false,
				retryAfterMs: error.retryAfterMs,
				error: error.message,
			};
		}

		const status = (error as { httpStatus?: number }).httpStatus;
		const reason = describeMatrixError(error, this.homeserverUrl);

		// Client errors (forbidden, unknown room) will not get better by retrying.
		if (status && status >= 400 && status < 500) {
			return { ok: false, error: reason };
		}

		return { ok: false, retryAfterMs: 2_000, error: reason };
	}

	private get stateDir(): string {
		return (
			this.context.stateDir ??
			join(".acpantenna", "channels", this.context.channelId)
		);
	}

	private async connect(): Promise<void> {
		this.baseUrl ??= await discoverBaseUrl(this.homeserverUrl);
		const whoami = await this.signIn();

		if (whoami.user_id !== this.config.userId) {
			throw new MatrixSetupError(
				`The access token belongs to ${whoami.user_id}, not ${this.config.userId}. Use the bot's own token, or change userId.`,
			);
		}

		const deviceId =
			(this.config.password ? undefined : this.config.deviceId) ||
			whoami.device_id;

		if (!deviceId) {
			throw new MatrixSetupError(
				"The homeserver did not say which device the access token is for; set deviceId.",
			);
		}

		if (whoami.device_id && whoami.device_id !== deviceId) {
			throw new MatrixSetupError(
				`The access token is for device ${whoami.device_id}, not ${deviceId}. Remove deviceId or set it to ${whoami.device_id}.`,
			);
		}

		this.deviceId = deviceId;
		const client = createClient({
			baseUrl: this.baseUrl,
			userId: this.config.userId,
			accessToken: this.accessToken,
			deviceId,
			// Secret storage, when the account has it, is opened with the bot's
			// own key (see ensureCrossSigning); nobody is ever asked for one.
			cryptoCallbacks: {
				getSecretStorageKey: async ({ keys }) => {
					const own = this.secretStorageKey;
					return own && keys[own.keyId]
						? [own.keyId, Buffer.from(own.key, "base64")]
						: null;
				},
				cacheSecretStorageKey: (keyId, _info, key) => {
					void this.keepSecretStorageKey(keyId, key);
				},
			},
			// No retries inside the SDK: rate limits are waited out in
			// withRateLimitRetry, and other failures go back to the gateway.
			scheduler: new MatrixScheduler(() => -1),
		});

		if (this.config.encryption !== false) {
			await this.startCrypto(client, deviceId);
		}

		this.client = client;
		this.listen(client);
		await client.startClient({
			initialSyncLimit: 1,
			lazyLoadMembers: true,
			pendingEventOrdering: PendingEventOrdering.Detached,
		});
	}

	private cryptoStorePath(deviceId: string): string {
		return join(
			this.stateDir,
			`crypto-${deviceId.replace(/[^A-Za-z0-9._-]/g, "_")}.bin`,
		);
	}

	private get sessionFile(): PrivateFile<StoredSession> {
		return new PrivateFile(join(this.stateDir, "session.json"));
	}

	/**
	 * Settle on a token: the configured one, or (with a password) the session
	 * a first login stored, logging in again if there is none or the
	 * homeserver no longer accepts it. Resolves to who the token is.
	 */
	private async signIn(): Promise<{ user_id: string; device_id?: string }> {
		const password = this.config.password;

		if (!password) {
			this.accessToken = this.config.accessToken;
			return await this.whoami();
		}

		const stored = await this.sessionFile.read();

		// A session whose device lost its keys is no use with encryption on: the
		// server holds keys for it the bot no longer has. A new login is.
		if (
			stored &&
			stored.userId === this.config.userId &&
			stored.homeserver === this.baseUrl &&
			(this.config.encryption === false ||
				existsSync(this.cryptoStorePath(stored.deviceId)))
		) {
			this.accessToken = stored.accessToken;

			try {
				return await this.whoami();
			} catch (error) {
				if (!(error instanceof MatrixSetupError)) {
					throw error;
				}

				this.context.logger.warn(
					"The stored Matrix session was rejected; logging in again as a new device.",
					{ reason: error.message },
				);
			}
		}

		const session = await passwordLogin({
			baseUrl: this.baseUrl ?? this.homeserverUrl,
			userId: this.config.userId,
			password,
			deviceName: this.config.deviceName || DEFAULT_DEVICE_NAME,
		});
		await this.sessionFile.write(session);
		this.accessToken = session.accessToken;
		this.context.logger.info("Logged in to Matrix as a new device.", {
			deviceId: session.deviceId,
		});
		return await this.whoami();
	}

	/** Who the token belongs to; a rejected token is a setup error, not an outage. */
	private async whoami(): Promise<{ user_id: string; device_id?: string }> {
		const response = await this.api("/_matrix/client/v3/account/whoami");
		const body = (await response.json().catch(() => ({}))) as {
			user_id?: string;
			device_id?: string;
			errcode?: string;
			error?: string;
		};

		if (response.ok && body.user_id) {
			return { user_id: body.user_id, device_id: body.device_id };
		}

		const error = Object.assign(
			new Error(body.error ?? `HTTP ${response.status}`),
			{
				errcode: body.errcode,
				httpStatus: response.status,
				data: body,
			},
		);

		if (
			body.errcode === "M_UNKNOWN_TOKEN" ||
			body.errcode === "M_MISSING_TOKEN" ||
			body.errcode === "M_USER_DEACTIVATED" ||
			response.status === 401
		) {
			throw new MatrixSetupError(
				describeMatrixError(error, this.homeserverUrl),
			);
		}

		throw error;
	}

	/** A request to the client API with the bot's token. */
	private api(path: string, init: RequestInit = {}): Promise<Response> {
		return fetch(`${this.baseUrl ?? this.homeserverUrl}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.accessToken ?? ""}`,
				"content-type": "application/json",
			},
			signal: AbortSignal.timeout(15_000),
		});
	}

	/**
	 * A device the bot has no key store for must be new. If the homeserver
	 * already has keys for it, another app made them (the token was copied
	 * from Element) or the store was lost; new keys under the same device would
	 * fail to upload, or show everyone a device whose keys changed.
	 */
	private async refuseDeviceWithKeys(deviceId: string): Promise<void> {
		const response = await this.api("/_matrix/client/v3/keys/query", {
			method: "POST",
			body: JSON.stringify({ device_keys: { [this.userId]: [deviceId] } }),
		});
		const body = (await response.json().catch(() => ({}))) as {
			device_keys?: Record<string, Record<string, unknown>>;
		};

		if (body.device_keys?.[this.userId]?.[deviceId]) {
			throw new MatrixSetupError(
				`The bot's device ${deviceId} already has encryption keys, made by another app (a token copied from Element?) or kept in a key store that is gone. Log the bot in again to get a token for a new device, and use that.`,
			);
		}
	}

	private async startCrypto(
		client: MatrixClient,
		deviceId: string,
	): Promise<void> {
		const stateDir = this.stateDir;
		const prefix = `${this.context.channelId}:${deviceId}`;
		const store = new CryptoStoreFile({
			path: this.cryptoStorePath(deviceId),
			prefix,
			onError: (error) => {
				this.context.logger.error("Could not save the Matrix crypto store.", {
					error: describeMatrixError(error, this.homeserverUrl),
				});
			},
		});

		if (!store.exists) {
			await this.refuseDeviceWithKeys(deviceId);
		}

		try {
			provideCryptoWasm();
			await store.load();
			await client.initRustCrypto({
				useIndexedDB: true,
				cryptoDatabasePrefix: prefix,
				...(this.config.storePassphrase
					? { storagePassword: this.config.storePassphrase }
					: {}),
			});
		} catch (error) {
			throw new MatrixSetupError(
				`End-to-end encryption could not start: ${error instanceof Error ? error.message : String(error)}. If the store passphrase changed, restore it; otherwise delete ${stateDir} to start the bot's encryption afresh (it will need verifying again).`,
			);
		} finally {
			releaseCryptoWasm();
		}

		this.cryptoStore = store;
	}

	private scheduleReconnect(): void {
		if (this.stopping) {
			return;
		}

		const delay =
			RECONNECT_DELAYS_MS[
				Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
			] ?? 60_000;
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.connect().catch((error) => {
				if (error instanceof MatrixSetupError) {
					this.setHealth("stopped", error.message);
					return;
				}

				this.setHealth(
					"degraded",
					describeMatrixError(error, this.homeserverUrl),
				);
				this.scheduleReconnect();
			});
		}, delay);
		(this.reconnectTimer as { unref?: () => void }).unref?.();
	}

	private setHealth(state: HealthState, message?: string): void {
		if (state !== this.healthState || message !== this.healthMessage) {
			const log = state === "ready" ? "info" : "warn";
			this.context.logger[log](
				`Matrix channel ${state}.`,
				message ? { reason: message } : undefined,
			);
		}

		this.healthState = state;
		this.healthMessage = message;
	}

	private listen(client: MatrixClient): void {
		client.on(ClientEvent.Sync, (state, _previous, data) => {
			switch (state) {
				case SyncState.Prepared:
					if (!this.prepared) {
						this.prepared = true;
						this.reconnectAttempt = 0;
						void this.afterFirstSync(client);
					}
					this.setHealth("ready");
					return;
				case SyncState.Syncing:
					this.setHealth("ready");
					return;
				case SyncState.Reconnecting:
					this.setHealth(
						"degraded",
						data?.error
							? describeMatrixError(data.error, this.homeserverUrl)
							: `Lost the connection to ${new URL(this.homeserverUrl).host}; reconnecting.`,
					);
					return;
				case SyncState.Error:
					this.setHealth(
						"degraded",
						describeMatrixError(data?.error, this.homeserverUrl),
					);
					return;
				case SyncState.Stopped:
					if (!this.stopping && this.healthState !== "stopped") {
						this.setHealth("stopped", "Syncing with the homeserver stopped.");
					}
					return;
				default:
					return;
			}
		});

		client.on(HttpApiEvent.SessionLoggedOut, (error) => {
			this.setHealth("stopped", describeMatrixError(error, this.homeserverUrl));
			client.stopClient();
		});

		client.on(RoomMemberEvent.Membership, (event, member) => {
			if (member.userId === this.userId && member.membership === "invite") {
				void this.considerInvite(client, member.roomId, event.getSender());
			}
		});

		client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline, removed) => {
			if (toStartOfTimeline || removed || !room) {
				return;
			}

			this.chainInbound(room.roomId, () =>
				this.onTimelineEvent(client, event, room),
			);
		});

		client.on(MatrixEventEvent.Decrypted, (event) => {
			const timer = this.awaitingDecryption.get(event.getId() ?? "");

			if (!timer || event.isDecryptionFailure()) {
				return;
			}

			clearTimeout(timer);
			this.awaitingDecryption.delete(event.getId() ?? "");
			const room = client.getRoom(event.getRoomId());

			if (room) {
				this.chainInbound(room.roomId, () =>
					this.handleClearEvent(client, event, room),
				);
			}
		});

		client.on(CryptoEvent.VerificationRequestReceived, (request) => {
			this.verifications.add(request);
			void this.onVerificationRequest(client, request)
				.catch((error) => {
					this.context.logger.warn("Verification failed.", {
						error: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => this.verifications.delete(request));
		});
	}

	/** Inbound work for a room runs in arrival order (decryption is async). */
	private chainInbound(roomId: string, task: () => Promise<void>): void {
		const previous = this.inboundChains.get(roomId) ?? Promise.resolve();
		const next = previous.then(task).catch((error) => {
			this.context.logger.error("Could not handle a Matrix event.", {
				roomId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		this.inboundChains.set(roomId, next);
	}

	private async afterFirstSync(client: MatrixClient): Promise<void> {
		for (const room of client.getRooms()) {
			if (room.getMyMembership() === "invite") {
				const inviter = room.getMember(this.userId)?.events.member?.getSender();
				await this.considerInvite(client, room.roomId, inviter);
			}
		}

		await this.ensureCrossSigning(client);
	}

	private get secretStorageKeyFile(): PrivateFile<StoredSecretStorageKey> {
		return new PrivateFile(join(this.stateDir, "secret-storage-key.json"));
	}

	private async keepSecretStorageKey(
		keyId: string,
		key: Uint8Array,
	): Promise<void> {
		this.secretStorageKey = {
			userId: this.userId,
			keyId,
			key: Buffer.from(key).toString("base64"),
		};

		try {
			await this.secretStorageKeyFile.write(this.secretStorageKey);
		} catch (error) {
			this.context.logger.error("Could not save the secret-storage key.", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Cross-sign the bot's own device, so Element does not flag its messages
	 * as coming from a device its owner never verified. A failure is retried
	 * every few minutes: under MAS a reset waits for an approval in a browser,
	 * and the bot finishes by itself once it is given.
	 */
	private async ensureCrossSigning(client: MatrixClient): Promise<void> {
		const crypto = client.getCrypto();

		if (!crypto || !this.deviceId || this.stopping) {
			return;
		}

		if (!this.secretStorageKey) {
			const stored = await this.secretStorageKeyFile.read();
			this.secretStorageKey =
				stored?.userId === this.userId ? stored : undefined;
		}

		try {
			const outcome = await ensureCrossSigning({
				crypto,
				secretStorage: client.secretStorage,
				userId: this.userId,
				deviceId: this.deviceId,
				ownSecretStorageKeyId: () => this.secretStorageKey?.keyId,
				auth: crossSigningAuth(this.userId, this.config.password),
			});

			if (outcome !== "ready") {
				this.context.logger.info("Cross-signed the bot's device.", {
					how: outcome,
				});
			}
		} catch (error) {
			if (error instanceof CrossSigningApprovalNeeded) {
				if (this.approvalUrlLogged !== error.url) {
					this.approvalUrlLogged = error.url;
					this.context.logger.warn(
						"The bot's device is not cross-signed yet: the account already has cross-signing keys from another app, and this homeserver only lets them be replaced after an approval. Open the link signed in as the bot and approve; the bot finishes within minutes.",
						{ url: error.url },
					);
				}
			} else {
				this.context.logger.warn(
					"Could not cross-sign the bot's device; Element will show its messages as from an unverified device. Retrying in a few minutes.",
					{ error: describeMatrixError(error, this.homeserverUrl) },
				);
			}

			this.crossSigningTimer = setTimeout(() => {
				void this.ensureCrossSigning(client);
			}, CROSS_SIGNING_RETRY_MS);
			(this.crossSigningTimer as { unref?: () => void }).unref?.();
		}
	}

	private async considerInvite(
		client: MatrixClient,
		roomId: string,
		inviter: string | undefined,
	): Promise<void> {
		if (
			!inviter ||
			!isSenderAllowed(this.config.permissions?.inbound, inviter, roomId)
		) {
			this.context.logger.info(
				"Ignored a Matrix invite from a sender not on the allowlist.",
				{
					roomId,
					inviter,
				},
			);
			return;
		}

		try {
			await withRateLimitRetry(() => client.joinRoom(roomId));
			this.context.logger.info("Joined a Matrix room.", { roomId, inviter });
		} catch (error) {
			this.context.logger.warn("Could not join a Matrix room.", {
				roomId,
				error: describeMatrixError(error, this.homeserverUrl),
			});
		}
	}

	private async onTimelineEvent(
		client: MatrixClient,
		event: MatrixEvent,
		room: Room,
	): Promise<void> {
		const eventId = event.getId();

		if (
			!eventId ||
			event.getSender() === this.userId ||
			// The backlog from before start is history, not something to answer.
			event.getTs() < this.startedAt ||
			this.processed.has(eventId)
		) {
			return;
		}

		if (event.isEncrypted()) {
			await client.decryptEventIfNeeded(event);

			if (event.isDecryptionFailure()) {
				// The key may still be on its way; Decrypted fires if it arrives.
				this.awaitingDecryption.set(
					eventId,
					setTimeout(() => {
						this.awaitingDecryption.delete(eventId);
						void this.reportUndecryptable(room.roomId, event);
					}, DECRYPTION_GRACE_MS),
				);
				return;
			}
		}

		await this.handleClearEvent(client, event, room);
	}

	private async reportUndecryptable(
		roomId: string,
		event: MatrixEvent,
	): Promise<void> {
		const sender = event.getSender() ?? "";

		if (!isSenderAllowed(this.config.permissions?.inbound, sender, roomId)) {
			return;
		}

		this.context.logger.warn("Could not decrypt a Matrix message.", {
			roomId,
			sender,
			reason: event.decryptionFailureReason,
		});
		await this.notice(
			roomId,
			"🔒 I couldn't decrypt your last message. If this keeps happening, check that your session shares keys with unverified devices, or verify the bot.",
		);
	}

	private async handleClearEvent(
		client: MatrixClient,
		event: MatrixEvent,
		room: Room,
	): Promise<void> {
		const eventId = event.getId();
		const sender = event.getSender();

		if (!eventId || !sender || this.processed.has(eventId)) {
			return;
		}

		this.remember(eventId);

		if (
			!isSenderAllowed(this.config.permissions?.inbound, sender, room.roomId)
		) {
			return;
		}

		const type = event.getType();
		const content = event.getContent();

		if (type === EventType.Reaction) {
			const relation = content["m.relates_to"] as
				| { event_id?: string; key?: string }
				| undefined;

			if (relation?.event_id && relation.key) {
				const pending = this.findPendingByEvent(room.roomId, relation.event_id);
				const answer = pending
					? answerFromReaction(pending, relation.key)
					: undefined;

				if (pending && answer) {
					await this.answer(room, pending, answer, event);
				}
			}

			return;
		}

		if (type !== EventType.RoomMessage) {
			return;
		}

		const relation = content["m.relates_to"] as
			| { rel_type?: string; "m.in_reply_to"?: { event_id?: string } }
			| undefined;

		// An edit of an earlier message is not a new prompt.
		if (relation?.rel_type === "m.replace") {
			return;
		}

		const msgtype = content.msgtype as string | undefined;

		if (msgtype === "m.notice") {
			// Notices are what bots send; answering them invites loops.
			return;
		}

		if (msgtype !== "m.text" && msgtype !== "m.emote") {
			await this.notice(room.roomId, "I can only read text messages for now.");
			return;
		}

		const rawBody = typeof content.body === "string" ? content.body : "";
		const repliedTo = relation?.["m.in_reply_to"]?.event_id;
		const text = repliedTo ? stripReplyFallback(rawBody) : rawBody;
		const pending = repliedTo
			? (this.findPendingByEvent(room.roomId, repliedTo) ??
				this.latestPending(room.roomId))
			: this.latestPending(room.roomId);
		const answer = pending ? answerFromText(pending, text) : undefined;

		if (pending && answer) {
			await this.answer(room, pending, answer, event);
			return;
		}

		// A new message ends the turn's live reply, so the next one starts
		// below the user's message.
		await this.outbox(room.roomId).endTurn();
		void client.sendTyping(room.roomId, true, 30_000).catch(() => undefined);
		this.emit(this.toInboundEvent(event, room, text));
	}

	private toInboundEvent(
		event: MatrixEvent,
		room: Room,
		text: string,
	): ChannelInboundEvent {
		const sender = event.getSender() ?? "";

		return createTextInboundEvent({
			id: event.getId(),
			text,
			conversationId: room.roomId,
			conversationType: room.getJoinedMemberCount() <= 2 ? "dm" : "room",
			senderId: sender,
			senderName: room.getMember(sender)?.name,
			timestamp: new Date(event.getTs()).toISOString(),
			raw: { eventId: event.getId(), roomId: room.roomId },
		});
	}

	/** Hand an event to the gateway without holding up the room's inbound order. */
	private emit(event: ChannelInboundEvent): void {
		void Promise.resolve(this.context.emit(event)).catch((error) => {
			this.context.logger.error("The gateway did not take a Matrix message.", {
				eventId: event.id,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private remember(eventId: string): void {
		this.processed.add(eventId);

		if (this.processed.size > PROCESSED_MEMORY) {
			const oldest = this.processed.values().next().value;

			if (oldest) {
				this.processed.delete(oldest);
			}
		}
	}

	private trackInteraction(
		roomId: string,
		eventId: string,
		message: ChannelOutboundMessage,
		content: Omit<MessageContent, "msgtype">,
	): void {
		const prompt = message.interaction;

		if (!prompt) {
			return;
		}

		const timeoutSeconds =
			this.config.permissions?.interactionTimeoutSeconds ?? 120;
		const pending = createPendingInteraction(
			prompt,
			Date.now() + timeoutSeconds * 1000,
		);
		pending.eventId = eventId;
		this.prompts.set(prompt.id, content);
		const room =
			this.pending.get(roomId) ?? new Map<string, PendingInteraction>();
		room.set(prompt.id, pending);
		this.pending.set(roomId, room);

		// One-tap answers: the bot puts the reactions there to be tapped.
		const outbox = this.outbox(roomId);

		for (const { key } of reactionKeys(pending.options)) {
			void outbox
				.run(() =>
					withRateLimitRetry(() =>
						this.requireClient().sendEvent(roomId, EventType.Reaction, {
							"m.relates_to": {
								rel_type: RelationType.Annotation,
								event_id: eventId,
								key,
							},
						}),
					),
				)
				.catch(() => undefined);
		}
	}

	private livePending(roomId: string): PendingInteraction[] {
		const room = this.pending.get(roomId);

		if (!room) {
			return [];
		}

		const now = Date.now();

		for (const [id, pending] of room) {
			if (pending.expiresAt < now) {
				room.delete(id);
			}
		}

		return [...room.values()];
	}

	private findPendingByEvent(
		roomId: string,
		eventId: string,
	): PendingInteraction | undefined {
		return this.livePending(roomId).find(
			(pending) => pending.eventId === eventId,
		);
	}

	private latestPending(roomId: string): PendingInteraction | undefined {
		return this.livePending(roomId).at(-1);
	}

	private async answer(
		room: Room,
		pending: PendingInteraction,
		response: ChannelInteractionResponse,
		event: MatrixEvent,
	): Promise<void> {
		this.pending.get(room.roomId)?.delete(pending.id);
		const sender = event.getSender() ?? "";
		const inbound = this.toInboundEvent(event, room, "");
		inbound.interaction = response;
		inbound.type =
			event.getType() === EventType.Reaction ? "reaction" : "message";
		this.emit(inbound);

		if (!pending.eventId) {
			return;
		}

		const prompt = this.outbox(room.roomId);
		const eventId = pending.eventId;
		const chosen = describeAnswer(pending, response);
		const shown = this.prompts.get(pending.id);
		this.prompts.delete(pending.id);

		if (shown?.body) {
			const by = room.getMember(sender)?.name ?? sender;
			void prompt
				.run(() =>
					this.transport(room.roomId).edit(eventId, {
						msgtype: "m.text",
						body: `${shown.body}\n→ ${chosen} (${by})`,
						...(shown.formatted_body
							? {
									format: "org.matrix.custom.html" as const,
									formatted_body: `${shown.formatted_body}<p>→ <strong>${escapeHtml(chosen)}</strong> (${escapeHtml(by)})</p>`,
								}
							: {}),
					}),
				)
				.catch(() => undefined);
		}
	}

	private async onVerificationRequest(
		client: MatrixClient,
		request: VerificationRequest,
	): Promise<void> {
		const roomId =
			request.roomId ?? this.sharedRoomWith(client, request.otherUserId);

		if (
			!isSenderAllowed(
				this.config.permissions?.inbound,
				request.otherUserId,
				roomId,
			)
		) {
			await request.cancel();
			return;
		}

		await request.accept();

		const verifier = await new Promise<
			NonNullable<VerificationRequest["verifier"]> | undefined
		>((resolve) => {
			const check = () => {
				if (request.verifier) {
					request.off(VerificationRequestEvent.Change, check);
					resolve(request.verifier);
				} else if (
					request.phase === VerificationPhase.Cancelled ||
					request.phase === VerificationPhase.Done
				) {
					request.off(VerificationRequestEvent.Change, check);
					resolve(undefined);
				}
			};
			request.on(VerificationRequestEvent.Change, check);
			check();
		});

		if (!verifier) {
			return;
		}

		verifier.on(VerifierEvent.ShowSas, (sas) => {
			const emoji = sas.sas.emoji ?? [];
			const shown = emoji
				.map(([symbol, name]) => `${symbol} ${name}`)
				.join("  ");

			void (async () => {
				if (roomId) {
					await this.notice(
						roomId,
						`🔐 Verifying with ${request.otherUserId}. My emoji: ${shown}. If Element shows the same ones, confirm there.`,
					);
				}

				// The person compares; on their side a mismatch cancels it.
				await sas.confirm();
			})();
		});

		await verifier.verify();
		this.context.logger.info("Verified with a Matrix user.", {
			userId: request.otherUserId,
		});
	}

	/** A joined room with `userId` in it, smallest first (a DM, if there is one). */
	private sharedRoomWith(
		client: MatrixClient,
		userId: string,
	): string | undefined {
		return client
			.getRooms()
			.filter(
				(room) =>
					room.getMyMembership() === "join" &&
					room.getMember(userId)?.membership === "join",
			)
			.sort(
				(left, right) =>
					left.getJoinedMemberCount() - right.getJoinedMemberCount(),
			)[0]?.roomId;
	}

	private async notice(roomId: string, text: string): Promise<void> {
		try {
			await this.outbox(roomId).send({ msgtype: "m.notice", body: text });
		} catch (error) {
			this.context.logger.warn("Could not send a notice.", {
				roomId,
				error: describeMatrixError(error, this.homeserverUrl),
			});
		}
	}

	private requireClient(): MatrixClient {
		if (!this.client) {
			throw new Error("The Matrix client is not running.");
		}

		return this.client;
	}

	private transport(roomId: string): LiveMessageTransport {
		const onLimited = (waitMs: number) => {
			this.context.logger.info("Rate-limited by the homeserver; waiting.", {
				roomId,
				waitMs,
			});
		};

		return {
			send: async (content, txnId) => {
				const client = this.requireClient();
				const response = await withRateLimitRetry(
					() =>
						client.sendEvent(
							roomId,
							EventType.RoomMessage,
							content as never,
							txnId,
						),
					{ onLimited },
				);
				// Someone is reading now; the typing notice has done its job.
				void client.sendTyping(roomId, false, 0).catch(() => undefined);
				return response.event_id;
			},
			edit: async (eventId, content) => {
				const client = this.requireClient();
				await withRateLimitRetry(
					() =>
						client.sendEvent(
							roomId,
							EventType.RoomMessage,
							editContent(eventId, content) as never,
						),
					{ onLimited },
				);
			},
		};
	}

	private outbox(roomId: string): RoomOutbox {
		let outbox = this.outboxes.get(roomId);

		if (!outbox) {
			outbox = new RoomOutbox({
				transport: this.transport(roomId),
				firstSendDelayMs: FIRST_SEND_DELAY_MS,
				editIntervalMs: this.config.editIntervalMs ?? 3_000,
				onError: (error) => {
					this.context.logger.warn("Could not update a Matrix message.", {
						roomId,
						error: describeMatrixError(error, this.homeserverUrl),
					});
				},
			});
			this.outboxes.set(roomId, outbox);
		}

		return outbox;
	}
}
