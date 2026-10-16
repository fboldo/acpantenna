import { expect, test } from "bun:test";
import type { ChannelInboundEvent, ChannelLogger } from "@acpantenna/channel";
import type { DiscordChannelConfig } from "./config.ts";
import { type GatewayPayload, Op, type SocketHandlers } from "./gateway.ts";
import { DiscordRuntime } from "./runtime.ts";

const BOT = "770000000000000000";
const ME = "420000000000000000";
const STRANGER = "430000000000000000";
const GUILD = "100000000000000000";
const CHANNEL = "200000000000000000";

const quiet: ChannelLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

interface Request {
	method: string;
	path: string;
	body?: Record<string, unknown>;
}

/** A Discord that answers REST from a script and speaks Gateway on a fake socket. */
async function fakeDiscord(config: Partial<DiscordChannelConfig> = {}) {
	const requests: Request[] = [];
	const emitted: ChannelInboundEvent[] = [];
	const sent: GatewayPayload[] = [];
	let handlers: SocketHandlers | undefined;
	let nextId = 1;

	const runtime = new DiscordRuntime(
		{
			type: "discord",
			botToken: "tok",
			permissions: { inbound: { mode: "allowlist", allow: [ME] } },
			...config,
		},
		{
			channelId: "discord",
			config: {},
			logger: quiet,
			emit: (event) => {
				emitted.push(event);
			},
		},
		{
			fetch: async (url, init) => {
				const path = url.replace("https://discord.com/api/v10", "");
				const body =
					typeof init.body === "string"
						? (JSON.parse(init.body) as Record<string, unknown>)
						: undefined;
				requests.push({ method: init.method ?? "GET", path, body });

				if (path === "/users/@me") {
					return Response.json({ id: BOT, username: "bot" });
				}

				if (path === "/gateway/bot") {
					return Response.json({ url: "wss://gateway.test" });
				}

				if (path.endsWith("/callback") || path.endsWith("/typing")) {
					return new Response(null, { status: 204 });
				}

				return Response.json({ id: `m${nextId++}` });
			},
			createSocket: (_url, socketHandlers) => {
				handlers = socketHandlers;
				return {
					send: (data) => sent.push(JSON.parse(data) as GatewayPayload),
					close: () => undefined,
				};
			},
		},
	);

	const receive = (payload: GatewayPayload) =>
		handlers?.message(JSON.stringify(payload));
	const dispatch = (t: string, d: unknown) =>
		receive({ op: Op.Dispatch, t, s: nextId, d });
	const settle = () => Bun.sleep(5);

	await runtime.start();
	await settle();
	receive({ op: Op.Hello, d: { heartbeat_interval: 45_000 } });
	dispatch("READY", {
		session_id: "s",
		resume_gateway_url: "wss://resume.test",
		user: { id: BOT, username: "bot" },
	});
	dispatch("GUILD_CREATE", {
		id: GUILD,
		channels: [{ id: CHANNEL, type: 0, name: "agent" }],
		threads: [],
	});

	return { runtime, requests, emitted, sent, dispatch, settle };
}

const message = (author: string, content: string, extra = {}) => ({
	id: `${Math.floor(Math.random() * 1e17)}`,
	channel_id: CHANNEL,
	guild_id: GUILD,
	type: 0,
	content,
	author: { id: author, username: "me" },
	...extra,
});

test("a message from the allowlist becomes a prompt; a stranger's is ignored", async () => {
	const discord = await fakeDiscord({ requireMention: true });

	try {
		expect(discord.sent[0]?.op).toBe(Op.Identify);
		expect(discord.runtime.health().state).toBe("ready");

		discord.dispatch("MESSAGE_CREATE", message(ME, `<@${BOT}> run the tests`));
		discord.dispatch("MESSAGE_CREATE", message(ME, "not for the bot"));
		discord.dispatch("MESSAGE_CREATE", message(STRANGER, `<@${BOT}> hi`));
		await discord.settle();

		expect(discord.emitted).toHaveLength(1);
		expect(discord.emitted[0]).toMatchObject({
			content: { text: "run the tests" },
			sender: { id: ME },
			conversation: {
				id: CHANNEL,
				type: "room",
				title: "#agent",
				parentIds: [GUILD],
			},
		});
		expect(discord.requests.map((r) => `${r.method} ${r.path}`)).toContain(
			`POST /channels/${CHANNEL}/typing`,
		);
	} finally {
		await discord.runtime.stop();
	}
});

test("a permission is sent with buttons and answered by pressing one", async () => {
	const discord = await fakeDiscord();

	try {
		const ack = await discord.runtime.send({
			conversationId: CHANNEL,
			text: "Run `make`?",
			interaction: {
				id: "perm-1",
				kind: "permission",
				options: [
					{ id: "allow", label: "Allow", kind: "allow" },
					{ id: "reject", label: "Reject", kind: "reject" },
				],
			},
		});
		const post = discord.requests.at(-1);

		expect(ack.ok).toBe(true);
		expect(post?.body).toMatchObject({
			content: "Run `make`?\n-# Tap a button, or reply with its number.",
			allowed_mentions: { parse: [] },
		});
		const row = (
			post?.body?.components as Array<{
				components: Array<{ custom_id: string }>;
			}>
		)[0];
		const allow = row?.components[0]?.custom_id ?? "";

		// Someone not on the list is told so, privately.
		discord.dispatch("INTERACTION_CREATE", {
			id: "900000000000000001",
			type: 3,
			token: "t1",
			channel_id: CHANNEL,
			guild_id: GUILD,
			member: { user: { id: STRANGER } },
			data: { custom_id: allow },
		});
		discord.dispatch("INTERACTION_CREATE", {
			id: "900000000000000002",
			type: 3,
			token: "t2",
			channel_id: CHANNEL,
			guild_id: GUILD,
			member: { user: { id: ME } },
			message: { id: ack.messageId },
			data: { custom_id: allow },
		});
		await discord.settle();

		const callbacks = discord.requests.filter((r) =>
			r.path.endsWith("/callback"),
		);
		expect(callbacks[0]?.body).toMatchObject({ type: 4, data: { flags: 64 } });
		expect(callbacks[1]?.body).toEqual({
			type: 7,
			data: {
				content: `Run \`make\`?\n→ **Allow** (<@${ME}>)`,
				components: [],
				allowed_mentions: { parse: [] },
			},
		});
		expect(discord.emitted).toHaveLength(1);
		expect(discord.emitted[0]?.interaction).toEqual({
			id: "perm-1",
			optionId: "allow",
		});
	} finally {
		await discord.runtime.stop();
	}
});

test("a long reply is sent as several messages; a file over the limit as a notice", async () => {
	const discord = await fakeDiscord({ maxUploadBytes: 10 });

	try {
		const before = discord.requests.length;
		await discord.runtime.send({
			conversationId: CHANNEL,
			text: `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`,
		});
		const posts = discord.requests.slice(before);

		expect(posts.map((r) => (r.body?.content as string).length)).toEqual([
			1500, 1500,
		]);

		const ack = await discord.runtime.send({
			conversationId: CHANNEL,
			attachment: {
				name: "big.bin",
				mimeType: "application/octet-stream",
				size: 2048,
				kind: "file",
				data: new Uint8Array(2048),
			},
		});

		expect(ack.ok).toBe(true);
		expect(discord.requests.at(-1)?.body).toMatchObject({
			content:
				"⚠️ Could not send big.bin (2 KB): Discord takes files up to 10 B here.",
			flags: 4 | 4096,
		});
	} finally {
		await discord.runtime.stop();
	}
});
