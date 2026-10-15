/**
 * A scripted web client for the relay tests: it opens a pairing link the way
 * a browser would, through the relay, on `@acpantenna/relay-protocol`, and
 * then speaks ACP as a client.
 */

import {
	type CloseEvent,
	initiator,
	type PairingLink,
	parseLink,
	parseRelayStatus,
	type RelaySession,
	type RelayStatus,
	roomId,
	roomPath,
} from "@acpantenna/relay-protocol";

export interface RpcAnswer {
	result?: unknown;
	error?: { code: number; message: string };
}

/** How the scripted browser answers the agent's requests. */
export type RequestHandler = (method: string, params: unknown) => unknown;

export class RelayBrowser {
	readonly link: PairingLink;
	readonly socket: WebSocket;
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
	readonly confirmed: Promise<void>;

	private constructor(link: string, relayUrl: string) {
		this.link = parseLink(link);
		this.socket = new WebSocket(
			`${relayUrl}${roomPath(roomId(this.link.room))}`,
		);
		this.socket.binaryType = "arraybuffer";
		this.confirmed = new Promise((resolve) => {
			this.confirmedResolve = resolve;
		});
	}

	/**
	 * Joins the link's room. With `handshake` false it only joins: the test
	 * then speaks for it on `socket`.
	 */
	static async open(
		link: string,
		relayUrl: string,
		options: { handshake?: boolean } = {},
	): Promise<RelayBrowser> {
		const browser = new RelayBrowser(link, relayUrl);
		const handshake = options.handshake ?? true;

		browser.socket.addEventListener("message", (event) => {
			if (typeof event.data === "string") {
				const status = parseRelayStatus(event.data);

				if (status) {
					browser.statuses.push(status);

					if (status.t === "ready" && handshake) {
						browser.startSession();
					}
				}
				return;
			}

			if (handshake) {
				browser.session?.receive(new Uint8Array(event.data as ArrayBuffer));
			}
		});
		browser.socket.addEventListener("close", (event) => {
			browser.socketClosed = { code: event.code, reason: event.reason };
			browser.session?.transportClosed();
		});
		await new Promise<void>((resolve, reject) => {
			browser.socket.addEventListener("open", () => resolve());
			browser.socket.addEventListener("error", () =>
				reject(new Error("Could not reach the relay")),
			);
		});
		browser.socket.send(JSON.stringify({ v: 1, role: "browser" }));

		return browser;
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
			onConfirmed: () => this.confirmedResolve?.(),
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
