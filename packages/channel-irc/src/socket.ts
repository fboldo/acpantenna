import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** A connection to the server, as the client uses it; a fake one in tests. */
export interface IrcSocket {
	write(data: string): void;
	/** Close it; `onClose` follows. */
	end(): void;
	onData(listener: (chunk: Uint8Array) => void): void;
	onClose(listener: (error?: Error) => void): void;
}

export interface ConnectOptions {
	host: string;
	port: number;
	tls: boolean;
	tlsVerify: boolean;
	timeoutMs: number;
}

export type Connect = (options: ConnectOptions) => Promise<IrcSocket>;

/** A TCP connection, over TLS unless told otherwise. Resolves once it is up. */
export const connectSocket: Connect = (options) =>
	new Promise((resolve, reject) => {
		let settled = false;
		const socket: Socket = options.tls
			? tlsConnect({
					host: options.host,
					port: options.port,
					servername: /^[\d.:]+$/.test(options.host) ? undefined : options.host,
					rejectUnauthorized: options.tlsVerify,
				})
			: netConnect({ host: options.host, port: options.port });
		const timer = setTimeout(() => {
			fail(
				new Error(`Timed out connecting to ${options.host}:${options.port}.`),
			);
			socket.destroy();
		}, options.timeoutMs);

		const fail = (error: Error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(error);
			}
		};

		socket.once("error", fail);
		socket.once(options.tls ? "secureConnect" : "connect", () => {
			settled = true;
			clearTimeout(timer);
			socket.off("error", fail);
			socket.setKeepAlive(true, 60_000);

			let closeError: Error | undefined;
			socket.on("error", (error) => {
				closeError = error;
			});

			resolve({
				write: (data) => {
					socket.write(data);
				},
				end: () => {
					socket.end();
					// A peer that never answers the FIN is not waited for.
					setTimeout(() => socket.destroy(), 5_000).unref?.();
				},
				onData: (listener) => {
					socket.on("data", (chunk: Buffer) => listener(chunk));
				},
				onClose: (listener) => {
					socket.once("close", () => listener(closeError));
				},
			});
		});
	});
