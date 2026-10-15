/**
 * A scripted web client for the relay tests: it opens a pairing link the way
 * a browser would, through the relay, on `@acpantenna/relay-protocol`, and
 * then speaks ACP as a client.
 */

import {
	type CloseEvent,
	generateKeyPair,
	initiator,
	type KeyPair,
	type PairingLink,
	parseLink,
	parseRelayStatus,
	type RelaySession,
	type RelayStatus,
	reconnectInitiator,
	roomId,
	roomPath,
	staticKey,
} from "@acpantenna/relay-protocol";

export interface RpcAnswer {
	result?: unknown;
	error?: { code: number; message: string };
}

/** How the scripted browser answers the agent's requests. */
export type RequestHandler = (method: string, params: unknown) => unknown;

export class RelayBrowser {
	readonly link: PairingLink;
	socket: WebSocket;
	/** Its key for reconnecting, once it has sent REMEMBER. */
	staticKeyPair: KeyPair | undefined;
	readonly statuses: RelayStatus[] = [];
	/** Every JSON-RPC message the agent side sent, parsed. */
	readonly received: Array<Record<string, unknown>> = [];
	session: RelaySession | undefined;
	words: string[] | undefined;
	closeEvent: CloseEvent | undefined;
	socketClosed: { code: number; reason: string } | undefined;
	onRequest: RequestHandler = () => ({ outcome: { outcome: "cancelled" } });
	private nextId = 1;
	private readonly waiting = new Map<unknown, (answer: RpcAnswer) => void>();
	private confirmedResolve: (() => void) | undefined;
	confirmed: Promise<void>;
	private readonly relayUrl: string;
	private readonly remember: boolean;

	private constructor(link: string, relayUrl: string, remember: boolean) {
		this.link = parseLink(link);
		this.relayUrl = relayUrl;
		this.remember = remember;
		this.socket = this.newSocket();
		this.confirmed = new Promise((resolve) => {
			this.confirmedResolve = resolve;
		});
	}

	private newSocket(): WebSocket {
		const socket = new WebSocket(
			`${this.relayUrl}${roomPath(roomId(this.link.room))}`,
		);

		socket.binaryType = "arraybuffer";
		return socket;
	}

	/**
	 * Joins the link's room. With `handshake` false it only joins: the test
	 * then speaks for it on `socket`.
	 */
	static async open(
		link: string,
		relayUrl: string,
		options: { handshake?: boolean; remember?: boolean } = {},
	): Promise<RelayBrowser> {
		const browser = new RelayBrowser(link, relayUrl, options.remember ?? false);

		await browser.join(options.handshake ?? true, () => browser.startSession());

		return browser;
	}

	/**
	 * Comes back as the remembered browser, on a new socket: carrying on
	 * where it stopped, or, with `resume` false, as a page that lost its
	 * state. `as` reconnects with another key instead, as a stranger would.
	 */
	async reconnect(
		options: { resume?: boolean; as?: KeyPair } = {},
	): Promise<void> {
		const keyPair = options.as ?? this.staticKeyPair;

		if (!keyPair) {
			throw new Error("This browser is not remembered");
		}

		const resume = options.resume ?? true;
		const buffer = this.session?.buffer;

		this.socket.close();
		this.socket = this.newSocket();
		this.closeEvent = undefined;
		this.socketClosed = undefined;
		this.confirmed = new Promise((resolve) => {
			this.confirmedResolve = resolve;
		});

		if (!resume) {
			this.waiting.clear();
			this.nextId = 1;
		}

		await this.join(
			true,
			() => {
				const session = reconnectInitiator({
					room: this.link.room,
					webOrigin: this.link.webOrigin,
					remoteStaticPublicKey: this.link.staticPublicKey,
					staticKey: staticKey(keyPair),
					resume,
					...(buffer ? { buffer } : {}),
					send: (data) => this.socket.send(data),
					onConfirmed: () => this.confirmedResolve?.(),
					onMessage: (text) => this.handleMessage(text),
					onClose: (event) => {
						this.closeEvent = event;
					},
				});

				this.session = session;
				session.start();
			},
			true,
		);
	}

	private async join(
		handshake: boolean,
		start: () => void,
		resume = false,
	): Promise<void> {
		const socket = this.socket;

		socket.addEventListener("message", (event) => {
			if (typeof event.data === "string") {
				const status = parseRelayStatus(event.data);

				if (status) {
					this.statuses.push(status);

					if (status.t === "ready" && handshake) {
						start();
					}
				}
				return;
			}

			if (handshake) {
				this.session?.receive(new Uint8Array(event.data as ArrayBuffer));
			}
		});
		socket.addEventListener("close", (event) => {
			if (socket !== this.socket) {
				return;
			}

			this.socketClosed = { code: event.code, reason: event.reason };
			this.session?.transportClosed();
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () =>
				reject(new Error("Could not reach the relay")),
			);
		});
		socket.send(
			JSON.stringify({ v: 1, role: "browser", ...(resume ? { resume } : {}) }),
		);
	}

	/** Sends a request and waits for its answer. */
	async rpc(
		method: string,
		params: unknown,
		id: string | number = this.nextId++,
	): Promise<RpcAnswer> {
		const answer = new Promise<RpcAnswer>((resolve) => {
			this.waiting.set(id, resolve);
		});

		this.requireSession().send(
			JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		);

		return await answer;
	}

	notify(method: string, params: unknown): void {
		this.requireSession().send(
			JSON.stringify({ jsonrpc: "2.0", method, params }),
		);
	}

	/** The text of every agent message chunk received so far. */
	text(): string {
		return this.received
			.filter((message) => message.method === "session/update")
			.map((message) => {
				const update = (message.params as { update?: Record<string, unknown> })
					.update;
				const content = update?.content as { text?: string } | undefined;

				return update?.sessionUpdate === "agent_message_chunk"
					? (content?.text ?? "")
					: "";
			})
			.join("");
	}

	close(): void {
		this.socket.close();
	}

	private startSession(): void {
		const session = initiator({
			link: this.link,
			send: (data) => this.socket.send(data),
			onHandshake: (info) => {
				this.words = info.sas;
			},
			onConfirmed: () => {
				if (this.remember) {
					this.staticKeyPair = generateKeyPair();
					session.remember(this.staticKeyPair.publicKey);
				}

				this.confirmedResolve?.();
			},
			onMessage: (text) => this.handleMessage(text),
			onClose: (event) => {
				this.closeEvent = event;
			},
		});

		this.session = session;
		session.start();
	}

	private handleMessage(text: string): void {
		const message = JSON.parse(text) as Record<string, unknown>;

		this.received.push(message);

		if (typeof message.method === "string" && message.id !== undefined) {
			const result = this.onRequest(message.method, message.params);

			this.requireSession().send(
				JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
			);
			return;
		}

		if (message.method === undefined) {
			const resolve = this.waiting.get(message.id);

			this.waiting.delete(message.id);
			resolve?.(message as RpcAnswer);
		}
	}

	private requireSession(): RelaySession {
		if (!this.session) {
			throw new Error("No session yet");
		}

		return this.session;
	}
}

/** Waits until `condition` holds, or fails after `timeoutMs`. */
export async function until(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 5000,
	what = "the condition",
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (await condition()) {
			return;
		}

		await Bun.sleep(20);
	}

	throw new Error(`Timed out waiting for ${what}`);
}
