import type { Connect, ConnectOptions, IrcSocket } from "../socket.ts";

/**
 * A server on the other end of a fake socket: records what the client
 * writes, line by line, and sends it lines back. Each connect is a new one.
 */
export function createFakeServer() {
	const connections: FakeConnection[] = [];
	let refuse = 0;

	const connect: Connect = async (options) => {
		if (refuse > 0) {
			refuse -= 1;
			throw Object.assign(new Error("connect ECONNREFUSED"), {
				code: "ECONNREFUSED",
			});
		}

		const connection = new FakeConnection(options);
		connections.push(connection);
		return connection.socket;
	};

	return {
		connect,
		connections,
		get last(): FakeConnection {
			const last = connections.at(-1);

			if (!last) {
				throw new Error("Nothing connected.");
			}

			return last;
		},
		/** The next `count` connects fail. */
		refuseNext(count: number) {
			refuse = count;
		},
	};
}

export class FakeConnection {
	public readonly written: string[] = [];
	public closed = false;
	private dataListener?: (chunk: Uint8Array) => void;
	private closeListener?: (error?: Error) => void;
	private partial = "";
	public readonly socket: IrcSocket;

	public constructor(public readonly options: ConnectOptions) {
		this.socket = {
			write: (data) => {
				this.partial += data;
				const lines = this.partial.split("\r\n");
				this.partial = lines.pop() ?? "";
				this.written.push(...lines);
			},
			end: () => this.close(),
			onData: (listener) => {
				this.dataListener = listener;
			},
			onClose: (listener) => {
				this.closeListener = listener;
			},
		};
	}

	/** Lines from the server, each sent with its CRLF. */
	public send(...lines: string[]): void {
		this.dataListener?.(
			new TextEncoder().encode(lines.map((line) => `${line}\r\n`).join("")),
		);
	}

	public close(error?: Error): void {
		if (!this.closed) {
			this.closed = true;
			this.closeListener?.(error);
		}
	}

	/** What the client wrote that starts with `command`. */
	public sent(command: string): string[] {
		return this.written.filter(
			(line) => line === command || line.startsWith(`${command} `),
		);
	}
}
