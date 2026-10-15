/// <reference types="bun" />

// Quiet the SDK in the test process too; it is the "human" side here.
import "../src/sdk-logs.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDecipheriv, createHash } from "node:crypto";
import {
	mkdtempSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	ClientEvent,
	createClient,
	EventType,
	type MatrixClient,
	type MatrixEvent,
	MatrixEventEvent,
	RelationType,
	SyncState,
} from "matrix-js-sdk";
import {
	VerificationPhase,
	VerifierEvent,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import {
	register,
	startHomeserver,
	type TestAccount,
	type TestHomeserver,
} from "./homeserver.ts";

/*
 * The whole path, for real: a homeserver, the CLI built into one file with
 * `bun build --target bun` and run from a directory with no node_modules, the
 * dumb ACP agent behind it, and a person in an encrypted room.
 */

const repoRoot = resolve(import.meta.dir, "../../..");
const dumbClientPath = join(repoRoot, "packages/acp-dumb-client/src/main.ts");
const workDir = mkdtempSync(join(tmpdir(), "acpantenna-matrix-e2e-"));
const bundlePath = join(workDir, "acpantenna.js");

let homeserver: TestHomeserver | undefined;
let bot: TestAccount;
let human: TestAccount;
let stranger: TestAccount;
let person: Person;
let gateway: Gateway | undefined;
/** The room of the first test, where the person later verifies the bot. */
let chatRoomId = "";

beforeAll(async () => {
	homeserver = await startHomeserver();

	if (!homeserver) {
		return;
	}

	const suffix = Date.now().toString(36);
	bot = await register(homeserver, `bot${suffix}`);
	human = await register(homeserver, `me${suffix}`);
	stranger = await register(homeserver, `stranger${suffix}`);
	person = await Person.start(homeserver, human);

	buildBundle();

	await Bun.write(
		join(workDir, "acpantenna.config.json"),
		JSON.stringify({
			server: { host: "127.0.0.1", port: await freePort() },
			state: { path: join(workDir, "state", "acpantenna.sqlite") },
			agents: {
				default: {
					command: "bun",
					args: [dumbClientPath, "--thoughts-and-tools", "--push-permission"],
					cwd: repoRoot,
				},
			},
			channels: {
				matrix: {
					type: "matrix",
					homeserverUrl: homeserver.url,
					userId: bot.userId,
					// biome-ignore lint/suspicious/noTemplateCurlyInString: a config placeholder the gateway expands.
					accessToken: "${MATRIX_BOT_TOKEN}",
					editIntervalMs: 500,
					permissions: {
						inbound: { mode: "allowlist", allow: [human.userId] },
						toolCalls: "ask",
					},
					delivery: { mode: "streamChunks" },
				},
			},
		}),
	);
}, 120_000);

afterAll(async () => {
	gateway?.stop();
	person?.client.stopClient();
	await homeserver?.stop();
	rmSync(workDir, { recursive: true, force: true });
});

const e2e = (name: string, run: () => Promise<void>) =>
	test(name, async () => {
		if (!homeserver) {
			console.warn(
				"Skipping: no homeserver (set MATRIX_E2E_HOMESERVER or install docker).",
			);
			return;
		}

		try {
			await run();
		} catch (error) {
			// The gateway's side of the story, for whoever reads the failure.
			console.error(`--- gateway log ---\n${gateway?.log() ?? ""}`);
			throw error;
		}
	}, 120_000);

e2e("an encrypted conversation, prompts and a restart", async () => {
	expect(statSync(bundlePath).size).toBeGreaterThan(1_000_000);
	gateway = await Gateway.start(workDir);
	const status = await gateway.waitForStatus(
		(matrix) => matrix?.state === "ready",
	);
	expect(status).toMatchObject({ state: "ready" });

	// Someone not on the allowlist invites the bot: it stays out.
	const strangerClient = createClient({
		baseUrl: homeserver!.url,
		userId: stranger.userId,
		accessToken: stranger.accessToken,
	});
	const ignored = await strangerClient.createRoom({ invite: [bot.userId] });

	const roomId = await person.createEncryptedRoom(bot.userId);
	chatRoomId = roomId;
	await person.waitForMember(roomId, bot.userId, "join");

	// A first turn: a tool-call notice, then the reply, all encrypted.
	await person.say(roomId, "hello bot");
	const reply = await person.waitForBotMessage(
		roomId,
		(message) => message.body === "dumb client: hello bot",
	);
	expect(reply.msgtype).toBe("m.text");
	const tools = await person.waitForBotMessage(roomId, (message) =>
		message.body.includes("dumb.lookup"),
	);
	expect(tools).toMatchObject({
		msgtype: "m.notice",
		body: "✅ 📖 dumb.lookup",
	});
	expect(await person.wireTypes(roomId)).not.toContain("m.room.message");

	// The agent asks a permission between turns: numbered, with reactions.
	const prompt = await person.waitForBotMessage(roomId, (message) =>
		message.body.includes("Ship it?"),
	);
	expect(prompt.body).toContain("1. ✅ Yes");
	expect(prompt.body).toContain("2. ❌ No");
	await waitFor(() => person.reactionsOn(roomId, prompt.eventId).length === 2);
	expect(new Set(person.reactionsOn(roomId, prompt.eventId))).toEqual(
		new Set(["✅", "❌"]),
	);

	// Tapping ✅ answers it.
	await person.react(roomId, prompt.eventId, "✅");
	await person.waitForBotMessage(
		roomId,
		(message) => message.body === "permission outcome: yes",
	);
	await waitFor(() =>
		person.latestBody(roomId, prompt.eventId).includes("→ Yes"),
	);

	// A second turn; this time the permission is answered by number.
	await person.say(roomId, "again");
	await person.waitForBotMessage(
		roomId,
		(message) => message.body === "dumb client: again",
	);
	const second = await person.waitForBotMessage(
		roomId,
		(message) =>
			message.body.includes("Ship it?") && message.eventId !== prompt.eventId,
	);
	await person.say(roomId, "2");
	await person.waitForBotMessage(
		roomId,
		(message) => message.body === "permission outcome: no",
	);
	expect(second.eventId).not.toBe(prompt.eventId);

	// The bot cross-signed its own device.
	const device = await person.client
		.getCrypto()!
		.getDeviceVerificationStatus(
			bot.userId,
			(await person.botDevice(bot.userId))!,
		);
	expect(device?.signedByOwner).toBe(true);
	expect(
		person.client.getRoom(ignored.room_id)?.getMember(bot.userId)?.membership,
	).not.toBe("join");

	// Restart: same keys from the store on disk, no answer to the backlog.
	const repliesBefore = person.botMessages(roomId).length;
	gateway.stop();
	await gateway.exited;
	gateway = await Gateway.start(workDir);
	await gateway.waitForStatus((matrix) => matrix?.state === "ready");
	await person.say(roomId, "after restart");
	await person.waitForBotMessage(
		roomId,
		(message) => message.body === "dumb client: after restart",
	);
	expect(
		person
			.botMessages(roomId)
			.slice(repliesBefore)
			.filter((message) => message.body.startsWith("dumb client: hello")),
	).toEqual([]);
	expect(person.undecryptable).toEqual([]);
});

e2e("the person verifies the bot with emoji", async () => {
	gateway ??= await Gateway.start(workDir);
	await gateway.waitForStatus((matrix) => matrix?.state === "ready");
	// In the room they have been chatting in, across the restart: the usual
	// case, and the one that once lost the verification mid-way.
	let roomId = chatRoomId;

	if (!roomId) {
		roomId = await person.createEncryptedRoom(bot.userId);
		await person.waitForMember(roomId, bot.userId, "join");
	}

	const crypto = person.client.getCrypto()!;
	await crypto.getUserDeviceInfo([bot.userId], true);

	await crypto.bootstrapCrossSigning({
		authUploadDeviceSigningKeys: async (makeRequest) => {
			await makeRequest({
				type: "m.login.password",
				identifier: { type: "m.id.user", user: human.userId },
				password: human.password,
			});
		},
	});

	const request = await crypto.requestVerificationDM(bot.userId, roomId);
	await waitFor(() => request.phase === VerificationPhase.Ready);
	const verifier = await request.startVerification("m.sas.v1");
	const shown = new Promise<string[]>((resolveShown) => {
		verifier.on(VerifierEvent.ShowSas, (sas) => {
			resolveShown((sas.sas.emoji ?? []).map(([symbol]) => symbol));
		});
	});
	const verifying = verifier.verify();
	const mine = await within(shown, "the emoji to show");

	// The bot posts its emoji in the room; they match what the person sees.
	const posted = await person.waitForBotMessage(roomId, (message) =>
		message.body.startsWith("🔐 Verifying"),
	);
	for (const symbol of mine) {
		expect(posted.body).toContain(symbol);
	}

	verifier.getShowSasCallbacks()?.confirm();
	await within(verifying, "the verification to finish");
	await waitFor(() => request.phase === VerificationPhase.Done);

	// Done, and the person's client has signed the bot's identity.
	await waitFor(async () =>
		(
			await crypto.getUserVerificationStatus(bot.userId)
		).isCrossSigningVerified(),
	);
});

e2e(
	"a device whose key store is gone is refused, not given new keys",
	async () => {
		gateway?.stop();
		await gateway?.exited;
		const elsewhere = join(workDir, "elsewhere");
		const config = await Bun.file(
			join(workDir, "acpantenna.config.json"),
		).json();
		config.state.path = join(elsewhere, "state", "acpantenna.sqlite");
		await Bun.write(
			join(elsewhere, "acpantenna.config.json"),
			JSON.stringify(config),
		);

		gateway = await Gateway.start(elsewhere);
		const matrix = await gateway.waitForStatus(
			(channel) => channel?.state === "failing",
		);

		expect(matrix?.lastError).toContain("already has encryption keys");
		gateway.stop();
		await gateway.exited;
		gateway = undefined;
	},
);

e2e(
	"an account another app set up: password login, then cross-signed with no prompt",
	async () => {
		gateway?.stop();
		await gateway?.exited;
		gateway = undefined;

		// The real bot's account: created and opened in Element first, so it has
		// cross-signing keys, kept in secret storage under a key the bot never sees.
		const account = await register(
			homeserver!,
			`preset${Date.now().toString(36)}`,
		);
		let thrownAway: { privateKey: Uint8Array<ArrayBuffer> } | undefined;
		const element = createClient({
			baseUrl: homeserver!.url,
			userId: account.userId,
			accessToken: account.accessToken,
			deviceId: account.deviceId,
			cryptoCallbacks: {
				getSecretStorageKey: async ({ keys }) => {
					const [keyId] = Object.keys(keys);
					return keyId && thrownAway ? [keyId, thrownAway.privateKey] : null;
				},
			},
		});
		await element.initRustCrypto({ useIndexedDB: false });
		const elementCrypto = element.getCrypto()!;
		await elementCrypto.bootstrapCrossSigning({
			authUploadDeviceSigningKeys: async (makeRequest) => {
				await makeRequest(null);
			},
		});
		const generated = await elementCrypto.createRecoveryKeyFromPassphrase();
		thrownAway = generated;
		await elementCrypto.bootstrapSecretStorage({
			setupNewSecretStorage: true,
			createSecretStorageKey: async () => generated,
		});
		expect(await element.secretStorage.getDefaultKeyId()).toBeTruthy();
		element.stopClient();

		const directory = join(workDir, "preset");
		const config = await Bun.file(
			join(workDir, "acpantenna.config.json"),
		).json();
		config.state.path = join(directory, "state", "acpantenna.sqlite");
		config.channels.matrix.userId = account.userId;
		await Bun.write(
			join(directory, "acpantenna.config.json"),
			JSON.stringify(config),
		);

		// With only a token (on its own device) the old keys cannot be replaced:
		// this homeserver wants the password for that. The bot says so, keeps
		// working, and has now left its own partial state behind.
		const tokenLogin = await login(homeserver!, account);
		gateway = await Gateway.start(directory, tokenLogin.accessToken);
		await gateway.waitForStatus((matrix) => matrix?.state === "ready");
		await waitFor(() =>
			gateway!.log().includes("set password in the channel config"),
		);
		gateway.stop();
		await gateway.exited;

		// The same state dir with the password instead: one login, as a new
		// device, then new cross-signing keys published with password UIA.
		config.channels.matrix.accessToken = undefined;
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a config placeholder the gateway expands.
		config.channels.matrix.password = "${MATRIX_BOT_PASSWORD}";
		config.channels.matrix.deviceName = "Agent";
		await Bun.write(
			join(directory, "acpantenna.config.json"),
			JSON.stringify(config),
		);
		const env = { MATRIX_BOT_PASSWORD: account.password };
		gateway = await Gateway.start(directory, "", env);
		await gateway.waitForStatus((matrix) => matrix?.state === "ready");
		await waitFor(() =>
			gateway!.log().includes("Cross-signed the bot's device"),
		);

		const stateDir = join(directory, "state", "channels", "matrix");
		const session = await Bun.file(join(stateDir, "session.json")).json();
		expect(session).toMatchObject({ userId: account.userId });
		expect(statSync(join(stateDir, "session.json")).mode & 0o777).toBe(0o600);
		expect(
			statSync(join(stateDir, "secret-storage-key.json")).mode & 0o777,
		).toBe(0o600);

		// What everyone else sees: the device signed by the account's
		// published self-signing key, under the name from the config.
		const published = await publishedDevice(
			homeserver!,
			human.accessToken,
			account.userId,
			session.deviceId,
		);
		expect(published.crossSigned).toBe(true);
		expect(published.displayName).toBe("Agent");

		// A restart reuses the stored session: no second login, nothing to redo.
		gateway.stop();
		await gateway.exited;
		gateway = await Gateway.start(directory, "", env);
		await gateway.waitForStatus((matrix) => matrix?.state === "ready");
		expect(
			(await Bun.file(join(stateDir, "session.json")).json()).deviceId,
		).toBe(session.deviceId);
		expect(gateway.log()).not.toContain("Logged in to Matrix");
		expect(gateway.log()).not.toContain("Cross-signed the bot's device");
		gateway.stop();
		await gateway.exited;
		gateway = undefined;
	},
);

e2e("health says why when the token is rejected", async () => {
	gateway?.stop();
	await gateway?.exited;
	gateway = await Gateway.start(workDir, "not-a-real-token");
	const matrix = await gateway.waitForStatus(
		(channel) => channel?.state === "failing",
	);

	expect(matrix?.lastError).toContain("The access token was rejected");
});

interface BotMessage {
	eventId: string;
	msgtype: string;
	body: string;
	content: Record<string, unknown>;
}

/** The person on the other side of the room, with their own encrypted client. */
class Person {
	public readonly undecryptable: string[] = [];
	private readonly messages = new Map<string, BotMessage[]>();
	private readonly edits = new Map<string, string>();
	private readonly reactions = new Map<string, string[]>();

	private constructor(
		public readonly client: MatrixClient,
		private readonly account: TestAccount,
	) {}

	public static async start(homeserver: TestHomeserver, account: TestAccount) {
		const client = createClient({
			baseUrl: homeserver.url,
			userId: account.userId,
			accessToken: account.accessToken,
			deviceId: account.deviceId,
		});
		await client.initRustCrypto({ useIndexedDB: false });
		const person = new Person(client, account);
		const prepared = new Promise<void>((resolveSync) => {
			client.on(ClientEvent.Sync, (state) => {
				if (state === SyncState.Prepared) {
					resolveSync();
				}
			});
		});
		client.on(MatrixEventEvent.Decrypted, (event) => person.record(event));
		client.on(
			"Room.timeline" as never,
			((event: MatrixEvent) => {
				if (!event.isEncrypted()) {
					person.record(event);
				}
			}) as never,
		);
		await client.startClient({ initialSyncLimit: 1 });
		await prepared;
		return person;
	}

	private record(event: MatrixEvent): void {
		const roomId = event.getRoomId();

		if (!roomId || event.getSender() === this.account.userId) {
			return;
		}

		if (event.isDecryptionFailure()) {
			this.undecryptable.push(event.getId() ?? "");
			return;
		}

		const content = event.getContent();
		const relation = content["m.relates_to"] as
			| { rel_type?: string; event_id?: string; key?: string }
			| undefined;

		if (
			event.getType() === EventType.Reaction &&
			relation?.event_id &&
			relation.key
		) {
			const list = this.reactions.get(relation.event_id) ?? [];
			list.push(relation.key);
			this.reactions.set(relation.event_id, list);
			return;
		}

		if (event.getType() !== EventType.RoomMessage) {
			return;
		}

		if (relation?.rel_type === RelationType.Replace && relation.event_id) {
			const replaced = content["m.new_content"] as
				| { body?: string }
				| undefined;
			this.edits.set(relation.event_id, replaced?.body ?? "");
			return;
		}

		const list = this.messages.get(roomId) ?? [];
		list.push({
			eventId: event.getId() ?? "",
			msgtype: String(content.msgtype),
			body: String(content.body),
			content,
		});
		this.messages.set(roomId, list);
	}

	public botMessages(roomId: string): BotMessage[] {
		return (this.messages.get(roomId) ?? []).map((message) => ({
			...message,
			body: this.edits.get(message.eventId) ?? message.body,
		}));
	}

	public latestBody(roomId: string, eventId: string): string {
		return (
			this.botMessages(roomId).find((message) => message.eventId === eventId)
				?.body ?? ""
		);
	}

	public reactionsOn(_roomId: string, eventId: string): string[] {
		return this.reactions.get(eventId) ?? [];
	}

	public async waitForBotMessage(
		roomId: string,
		predicate: (message: BotMessage) => boolean,
	): Promise<BotMessage> {
		let found: BotMessage | undefined;
		await waitFor(() => {
			found = this.botMessages(roomId).find(predicate);
			return found !== undefined;
		});
		return found!;
	}

	public async createEncryptedRoom(invite: string): Promise<string> {
		const { room_id } = await this.client.createRoom({
			invite: [invite],
			is_direct: true,
			initial_state: [
				{
					type: "m.room.encryption",
					state_key: "",
					content: { algorithm: "m.megolm.v1.aes-sha2" },
				},
			],
		});
		return room_id;
	}

	public async waitForMember(
		roomId: string,
		userId: string,
		membership: string,
	) {
		await waitFor(
			() =>
				this.client.getRoom(roomId)?.getMember(userId)?.membership ===
				membership,
		);
	}

	public async say(roomId: string, text: string): Promise<void> {
		await this.client.sendTextMessage(roomId, text);
	}

	public async react(
		roomId: string,
		eventId: string,
		key: string,
	): Promise<void> {
		await this.client.sendEvent(roomId, EventType.Reaction, {
			"m.relates_to": {
				rel_type: RelationType.Annotation,
				event_id: eventId,
				key,
			},
		});
	}

	public async botDevice(userId: string): Promise<string | undefined> {
		const devices = await this.client
			.getCrypto()!
			.getUserDeviceInfo([userId], true);
		return [...(devices.get(userId)?.keys() ?? [])][0];
	}

	/** Event types as the homeserver stores them, which only it and we can see. */
	public async wireTypes(roomId: string): Promise<string[]> {
		const response = await this.client.createMessagesRequest(
			roomId,
			null,
			30,
			"b" as never,
		);
		return response.chunk
			.filter((event) => event.sender !== this.account.userId)
			.map((event) => event.type);
	}
}

// A 37×21 red PNG, from ImageMagick (`convert -size 37x21 xc:red -strip`).
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAACUAAAAVAQMAAAD7KrXtAAAAA1BMVEX/AAAZ4gk3AAAADElEQVQI12NgGEgAAAB+AAH9tTdSAAAAAElFTkSuQmCC",
	"base64",
);

e2e(
	"a file the agent sends arrives encrypted, and one too large is refused in words",
	async () => {
		// A gateway of its own, with the bot's real token: the test before
		// this one leaves one running with a rejected token.
		gateway?.stop();
		await gateway?.exited;
		gateway = await Gateway.start(workDir);
		await gateway.waitForStatus((matrix) => matrix?.state === "ready");
		const roomId = await person.createEncryptedRoom(bot.userId);
		await person.waitForMember(roomId, bot.userId, "join");

		const shot = join(workDir, "screen.png");
		writeFileSync(shot, PNG);
		await person.say(roomId, `attach ${shot}`);
		const image = await person.waitForBotMessage(
			roomId,
			(message) => message.msgtype === "m.image",
		);
		expect(image.content).toMatchObject({
			body: "screen.png",
			filename: "screen.png",
			info: { mimetype: "image/png", size: PNG.length, w: 37, h: 21 },
		});
		// Encrypted room: the key travels in the (encrypted) event, never `url`.
		expect(image.content.url).toBeUndefined();
		const file = image.content.file as {
			url: string;
			key: { k: string };
			iv: string;
			hashes: { sha256: string };
		};

		// What the homeserver holds is ciphertext that decrypts to the file.
		const [server, mediaId] = file.url.replace("mxc://", "").split("/");
		const download = await fetch(
			`${homeserver!.url}/_matrix/client/v1/media/download/${server}/${mediaId}`,
			{ headers: { Authorization: `Bearer ${human.accessToken}` } },
		);
		expect(download.ok).toBe(true);
		const ciphertext = Buffer.from(await download.arrayBuffer());
		expect(ciphertext.equals(PNG)).toBe(false);
		expect(
			createHash("sha256")
				.update(ciphertext)
				.digest("base64")
				.replace(/=+$/, ""),
		).toBe(file.hashes.sha256);
		const decipher = createDecipheriv(
			"aes-256-ctr",
			Buffer.from(file.key.k, "base64url"),
			Buffer.from(file.iv, "base64"),
		);
		expect(
			Buffer.concat([decipher.update(ciphertext), decipher.final()]).equals(
				PNG,
			),
		).toBe(true);

		// One byte over the server's own limit: refused before it is read or
		// uploaded, and said in the room. Sparse, so it costs no disk.
		const config = (await (
			await fetch(`${homeserver!.url}/_matrix/client/v1/media/config`, {
				headers: { Authorization: `Bearer ${human.accessToken}` },
			})
		).json()) as { "m.upload.size"?: number };
		const limit = config["m.upload.size"];
		expect(typeof limit).toBe("number");
		const big = join(workDir, "big.bin");
		writeFileSync(big, "");
		truncateSync(big, (limit ?? 0) + 1);
		await person.say(roomId, `attach ${big}`);
		const refused = await person.waitForBotMessage(roomId, (message) =>
			message.body.startsWith("⚠️ Could not send big.bin"),
		);
		expect(refused.msgtype).toBe("m.notice");
		expect(refused.body).toContain("accepts files up to");
		expect(person.undecryptable).toEqual([]);
	},
);

/** The bundled gateway, run where no node_modules can be found. */
class Gateway {
	private constructor(
		private readonly process: ReturnType<typeof Bun.spawn>,
		private readonly baseUrl: string,
		private readonly output: string[],
	) {}

	public get exited(): Promise<number | null> {
		return this.process.exited;
	}

	public static async start(
		directory: string,
		token = bot.accessToken,
		env: Record<string, string> = {},
	): Promise<Gateway> {
		const configPath = join(directory, "acpantenna.config.json");
		const config = (await Bun.file(configPath).json()) as {
			server: { port: number };
		};
		const child = Bun.spawn({
			cmd: ["bun", bundlePath, "serve", "--config", configPath],
			cwd: directory,
			env: {
				...process.env,
				MATRIX_BOT_TOKEN: token,
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const output: string[] = [];
		void collect(child.stdout as ReadableStream<Uint8Array>, output);
		void collect(child.stderr as ReadableStream<Uint8Array>, output);
		const gateway = new Gateway(
			child,
			`http://127.0.0.1:${config.server.port}`,
			output,
		);

		await waitFor(async () => {
			try {
				return (await fetch(`${gateway.baseUrl}/health`)).ok;
			} catch {
				return false;
			}
		}).catch((error) => {
			throw new Error(`${error}\n${output.join("")}`);
		});

		return gateway;
	}

	public async waitForStatus(
		predicate: (
			matrix: { state?: string; lastError?: string } | undefined,
		) => boolean,
	) {
		let matrix: { state?: string; lastError?: string } | undefined;
		await waitFor(async () => {
			const status = (await (await fetch(`${this.baseUrl}/status`)).json()) as {
				channels?: Record<string, { state?: string; lastError?: string }>;
			};
			matrix = status.channels?.matrix;
			return predicate(matrix);
		}).catch((error) => {
			throw new Error(
				`${error}: ${JSON.stringify(matrix)}\n${this.output.join("")}`,
			);
		});
		return matrix;
	}

	public stop(): void {
		this.process.kill("SIGTERM");
	}

	/** The gateway's and channel's log lines, without the console trace spans. */
	public log(): string {
		return this.output
			.join("")
			.split("\n")
			.filter(
				(line) =>
					line.startsWith("[channel:") || line.startsWith("[acpantenna]"),
			)
			.join("\n");
	}
}

/**
 * `bun build` of the CLI into one file, as a host that embeds it does. Bun 1.3.8's bundler hangs
 * now and then (about one build in thirty here; not seen with 1.4.2), so a
 * build that takes too long is tried again.
 */
function buildBundle(): void {
	let stderr = "";

	for (let attempt = 0; attempt < 3; attempt += 1) {
		const build = Bun.spawnSync(
			[
				"bun",
				"build",
				join(repoRoot, "packages/cli/src/main.ts"),
				"--target",
				"bun",
				"--outfile",
				bundlePath,
			],
			{ cwd: repoRoot, timeout: 30_000 },
		);

		if (build.exitCode === 0) {
			return;
		}

		stderr = build.stderr.toString();
	}

	throw new Error(`bun build failed: ${stderr}`);
}

async function collect(stream: ReadableStream<Uint8Array>, into: string[]) {
	const decoder = new TextDecoder();

	for await (const chunk of stream) {
		into.push(decoder.decode(chunk));
	}
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 30_000,
): Promise<void> {
	const waiting = new Error("Timed out waiting.");

	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}

		await Bun.sleep(100);
	}

	throw waiting;
}

/**
 * A device as the homeserver publishes it: whether the account's current
 * self-signing key has signed it, and its display name.
 */
async function publishedDevice(
	homeserver: TestHomeserver,
	asToken: string,
	userId: string,
	deviceId: string,
) {
	const response = await fetch(
		`${homeserver.url}/_matrix/client/v3/keys/query`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${asToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ device_keys: { [userId]: [deviceId] } }),
		},
	);
	const body = (await response.json()) as {
		device_keys: Record<
			string,
			Record<
				string,
				{
					signatures: Record<string, Record<string, string>>;
					unsigned?: { device_display_name?: string };
				}
			>
		>;
		self_signing_keys?: Record<string, { keys: Record<string, string> }>;
	};
	const device = body.device_keys[userId]?.[deviceId];
	const selfSigning = Object.keys(body.self_signing_keys?.[userId]?.keys ?? {});

	return {
		crossSigned: selfSigning.some(
			(keyId) => device?.signatures[userId]?.[keyId] !== undefined,
		),
		displayName: device?.unsigned?.device_display_name,
	};
}

/** A fresh password login for `account`: a new device of its own. */
async function login(homeserver: TestHomeserver, account: TestAccount) {
	const response = await fetch(`${homeserver.url}/_matrix/client/v3/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "m.login.password",
			identifier: { type: "m.id.user", user: account.userId },
			password: account.password,
		}),
	});
	const body = (await response.json()) as {
		access_token: string;
		device_id: string;
	};
	return { accessToken: body.access_token, deviceId: body.device_id };
}

async function within<T>(
	promise: Promise<T>,
	what: string,
	ms = 30_000,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Timed out waiting for ${what}.`)),
			ms,
		);
	});

	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = server.port ?? 0;
	server.stop(true);
	return port;
}
