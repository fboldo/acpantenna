#!/usr/bin/env bun

/**
 * A relay for tests and local development, as the spec's §1 describes:
 * rooms of one agent and one browser at `/v1/rooms/<room>`, the hello, the
 * status messages, binary frames forwarded unchanged, and the room's limits.
 * It keeps everything in memory and logs nothing about rooms.
 *
 *     bun packages/channel-relay/src/dev-relay.ts [--port 8787] [--time-limit-minutes 60]
 */

import {
	CLOSE_CODE_ROOM_FULL,
	MAX_RELAY_BINARY_LENGTH,
	parseRelayHello,
	type RelayCloseReason,
	type RelayRole,
	type RelayStatus,
} from "@acpantenna/relay-protocol";
import type { Server, ServerWebSocket } from "bun";

export interface DevRelayOptions {
	hostname?: string;
	/** 0 picks a free port. Default 0. */
	port?: number;
	/** How long a room lasts after `ready`. Default 60 minutes. */
	timeLimitMs?: number;
	/** How long an empty room is kept. Default 15 minutes. */
	roomTtlMs?: number;
}

export interface DevRelay {
	/** `ws://host:port`, to put in a relay channel's `relayUrl`. */
	url: string;
	port: number;
	/** How many rooms there are now. */
	rooms(): number;
	stop(): Promise<void>;
}

interface Peer {
	room: string;
	role?: RelayRole;
}

interface Room {
	agent?: ServerWebSocket<Peer>;
	browser?: ServerWebSocket<Peer>;
	timeLimit?: ReturnType<typeof setTimeout>;
	ttl?: ReturnType<typeof setTimeout>;
}

const ROOM_PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})$/;

export function startDevRelay(options: DevRelayOptions = {}): DevRelay {
	const timeLimitMs = options.timeLimitMs ?? 60 * 60_000;
	const roomTtlMs = options.roomTtlMs ?? 15 * 60_000;
	const rooms = new Map<string, Room>();

	const sendStatus = (socket: ServerWebSocket<Peer>, status: RelayStatus) => {
		socket.send(JSON.stringify(status));
	};

	const closeRoom = (id: string, reason: RelayCloseReason) => {
		const room = rooms.get(id);

		if (!room) {
			return;
		}

		rooms.delete(id);
		clearTimeout(room.timeLimit);
		clearTimeout(room.ttl);

		for (const socket of [room.agent, room.browser]) {
			if (socket) {
				sendStatus(socket, { t: "closed", reason });
				socket.close(1000, reason);
			}
		}
	};

	const join = (socket: ServerWebSocket<Peer>, role: RelayRole) => {
		const id = socket.data.room;
		let room = rooms.get(id);

		if (role === "browser" && !room?.agent) {
			sendStatus(socket, { t: "closed", reason: "ttl" });
			socket.close(1000, "ttl");
			return;
		}

		if (role === "browser" && room?.browser) {
			socket.close(CLOSE_CODE_ROOM_FULL, "room full");
			return;
		}

		if (!room) {
			room = {};
			rooms.set(id, room);
		}

		clearTimeout(room.ttl);
		room.ttl = undefined;

		if (role === "agent" && room.agent) {
			const previous = room.agent;

			room.agent = undefined;
			previous.data.role = undefined;
			sendStatus(previous, { t: "closed", reason: "replaced" });
			previous.close(1000, "replaced");
		}

		socket.data.role = role;
		room[role] = socket;

		if (!room.agent || !room.browser) {
			sendStatus(socket, { t: "waiting" });
			return;
		}

		sendStatus(room.agent, { t: "ready" });
		sendStatus(room.browser, { t: "ready" });
		room.timeLimit ??= setTimeout(
			() => closeRoom(id, "time-limit"),
			timeLimitMs,
		);
	};

	const leave = (socket: ServerWebSocket<Peer>) => {
		const id = socket.data.room;
		const room = rooms.get(id);
		const role = socket.data.role;

		if (!room || !role || room[role] !== socket) {
			return;
		}

		room[role] = undefined;
		const other = role === "agent" ? room.browser : room.agent;

		if (other) {
			sendStatus(other, { t: "peer-left" });
			return;
		}

		room.ttl = setTimeout(() => closeRoom(id, "ttl"), roomTtlMs);
	};

	const server: Server<Peer> = Bun.serve<Peer>({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port ?? 0,
		fetch(request, server) {
			const match = ROOM_PATH.exec(new URL(request.url).pathname);

			if (!match?.[1]) {
				return new Response("Not found", { status: 404 });
			}

			return server.upgrade(request, { data: { room: match[1] } })
				? undefined
				: new Response("Expected a WebSocket", { status: 426 });
		},
		websocket: {
			// Larger than a frame may be, so an oversized one closes the room as the
			// spec says, rather than only its socket.
			maxPayloadLength: 1024 * 1024,
			message(socket, message) {
				const id = socket.data.room;

				if (!socket.data.role) {
					const hello =
						typeof message === "string" ? parseRelayHello(message) : undefined;

					if (!hello) {
						socket.close(1002, "protocol");
						return;
					}

					join(socket, hello.role);
					return;
				}

				if (
					typeof message === "string" ||
					message.length > MAX_RELAY_BINARY_LENGTH
				) {
					closeRoom(id, "protocol");
					return;
				}

				const room = rooms.get(id);
				const other =
					socket.data.role === "agent" ? room?.browser : room?.agent;

				// Only between two peers that have both been told `ready`.
				if (room?.agent && room.browser && other) {
					other.send(message);
				}
			},
			close(socket) {
				leave(socket);
			},
		},
	});

	return {
		url: `ws://${server.hostname}:${server.port}`,
		port: server.port ?? 0,
		rooms: () => rooms.size,
		stop: async () => {
			for (const id of [...rooms.keys()]) {
				closeRoom(id, "ttl");
			}

			await server.stop(true);
		},
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const value = (name: string) => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const relay = startDevRelay({
		port: Number(value("--port") ?? 8787),
		timeLimitMs: Number(value("--time-limit-minutes") ?? 60) * 60_000,
	});

	console.log(`Development relay on ${relay.url}`);
}
