#!/usr/bin/env bun

/// <reference types="bun" />

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	ChannelFactory,
	ChannelInboundEvent,
	ChannelOutboundMessage,
} from "@acpantenna/channel";
import { createTextInboundEvent } from "@acpantenna/channel";
import { type AgentConfig, normalizeConfig } from "@acpantenna/config";
import { AcpAntennaGateway } from "@acpantenna/core";

const repoRoot = resolve(import.meta.dir, "..");
const dumbClientPath = join(
	repoRoot,
	"packages",
	"acp-dumb-client",
	"src",
	"main.ts",
);

/** A directory to connect in, absolute on every OS. */
const TMP = resolve("/tmp");

/** The agent `connect` reaches by id, as `claude` is reached through its preset. */
const connectedAgent: AgentConfig = {
	command: "bun",
	args: [
		dumbClientPath,
		"--response-prefix",
		"connected: ",
		"--echo-context",
		"--resume",
		"--fork",
		"--close-sessions",
	],
	cwd: repoRoot,
};

interface Harness {
	gateway: AcpAntennaGateway;
	sends: ChannelOutboundMessage[];
	/** Say something in a conversation and wait for the reply to it. */
	ask(text: string, conversationId?: string): Promise<string | undefined>;
}

async function startHarness(
	options: {
		channelAgentArgs?: string[];
		channel?: Record<string, unknown>;
		statePath?: string;
	} = {},
): Promise<Harness> {
	const sends: ChannelOutboundMessage[] = [];
	let emit: ((event: ChannelInboundEvent) => Promise<void> | void) | undefined;

	const factory: ChannelFactory<unknown> = () => ({
		manifest: { type: "chat", name: "Chat", version: "0.0.0" },
		start(context) {
			emit = context.emit;
		},
		send(message) {
			sends.push(message);
			return { ok: true, messageId: message.id };
		},
	});

	const config = normalizeConfig({
		agents: {
			dumb: {
				command: "bun",
				args: [
					dumbClientPath,
					"--response-prefix",
					"channel agent: ",
					...(options.channelAgentArgs ?? []),
				],
				cwd: repoRoot,
			},
		},
		channels: {
			chat: {
				type: "chat",
				permissions: { inbound: { mode: "open" } },
				...options.channel,
			},
		},
		state: options.statePath
			? { driver: "sqlite", path: options.statePath }
			: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { chat: factory },
		resolveAgent: (agentId) =>
			agentId === "connected" ? connectedAgent : undefined,
		logger: silentLogger,
	});

	await gateway.start();

	return {
		gateway,
		sends,
		ask: async (text, conversationId = "room-1") => {
			if (!emit) {
				throw new Error("channel not started");
			}

			const before = sends.length;
			await emit(
				createTextInboundEvent({ text, conversationId, senderId: "u1" }),
			);

			return sends.slice(before).find((message) => message.text)?.text;
		},
	};
}

function tempDir(prefix: string): string {
	const root = join(repoRoot, "out");
	mkdirSync(root, { recursive: true });
	return mkdtempSync(join(root, prefix));
}

test("connects a conversation to a new session of an agent the config does not name", async () => {
	const workDir = tempDir("acpantenna-connect-");
	const harness = await startHarness();

	try {
		const connection = await harness.gateway.connect({
			channelId: "chat",
			conversationId: "room-1",
			agentId: "connected",
			cwd: workDir,
		});

		expect(connection).toMatchObject({
			channelId: "chat",
			conversationId: "room-1",
			agentId: "connected",
			acpSessionId: "dumb-session-1",
			cwd: workDir,
			connection: true,
		});
		expect(await harness.ask("hi")).toBe(
			`[dumb-session-1 ${workDir}] connected: hi`,
		);
		// Another conversation of the same channel keeps the channel's agent.
		expect(await harness.ask("hi", "room-2")).toBe("channel agent: hi");
		expect(await harness.gateway.listConnections()).toHaveLength(1);
		expect((await harness.gateway.status()).agents.connected?.state).toBe("up");
	} finally {
		await harness.gateway.stop();
		rmSync(workDir, { recursive: true, force: true });
	}
}, 15_000);

test("resumes an existing session by id, in the directory it was given", async () => {
	const harness = await startHarness();

	try {
		await harness.gateway.connect({
			channelId: "chat",
			conversationId: "room-1",
			agentId: "connected",
			acpSessionId: "eb58eef6-claude",
			cwd: TMP,
		});

		expect(await harness.ask("hi")).toBe(
			`[eb58eef6-claude ${TMP}] connected: hi`,
		);
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

test("forks an existing session rather than resuming it, when asked", async () => {
	const harness = await startHarness();

	try {
		const connection = await harness.gateway.connect({
			channelId: "chat",
			conversationId: "room-1",
			agentId: "connected",
			acpSessionId: "original",
			fork: true,
			cwd: TMP,
		});

		expect(connection.acpSessionId).toStartWith("original-fork-");
		expect(await harness.ask("hi")).toBe(
			`[${connection.acpSessionId} ${TMP}] connected: hi`,
		);
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

test("holds one connection per conversation; disconnect hands it back and stops the agent", async () => {
	const harness = await startHarness();
	const room = { channelId: "chat", conversationId: "room-1" };

	try {
		const first = await harness.gateway.connect({
			...room,
			agentId: "connected",
			acpSessionId: "first",
		});

		// The same connection again is no change.
		expect(
			await harness.gateway.connect({
				...room,
				agentId: "connected",
				acpSessionId: "first",
			}),
		).toEqual(first);
		await expect(
			harness.gateway.connect({
				...room,
				agentId: "connected",
				acpSessionId: "second",
			}),
		).rejects.toThrow("already connected to session first");

		expect(await harness.gateway.disconnect(room)).toMatchObject({
			acpSessionId: "first",
		});
		expect(await harness.gateway.disconnect(room)).toBeUndefined();
		expect(await harness.gateway.listConnections()).toEqual([]);
		expect(await harness.ask("hi")).toBe("channel agent: hi");
		// Nothing uses the agent the connection started, so it is gone.
		expect((await harness.gateway.status()).agents.connected).toBeUndefined();
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

test("/new starts a fresh session and keeps the conversation connected", async () => {
	const harness = await startHarness();

	try {
		await harness.gateway.connect({
			channelId: "chat",
			conversationId: "room-1",
			agentId: "connected",
			acpSessionId: "before",
			cwd: TMP,
		});

		expect(await harness.ask("/new")).toBe("Started a new session.");
		expect(await harness.ask("hi")).toBe(
			`[dumb-session-1 ${TMP}] connected: hi`,
		);

		const [connection] = await harness.gateway.listConnections();
		expect(connection).toMatchObject({
			acpSessionId: "dumb-session-1",
			cwd: TMP,
			connection: true,
		});
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

test("keeps a connection across a restart", async () => {
	const dir = tempDir("acpantenna-connect-restart-");
	const statePath = join(dir, "state.sqlite");

	try {
		const first = await startHarness({ statePath });
		await first.gateway.connect({
			channelId: "chat",
			conversationId: "room-1",
			agentId: "connected",
			acpSessionId: "persisted",
			cwd: TMP,
		});
		await first.gateway.stop();

		const second = await startHarness({ statePath });

		try {
			expect(await second.ask("hi")).toBe(`[persisted ${TMP}] connected: hi`);
			expect(await second.gateway.listConnections()).toHaveLength(1);
		} finally {
			await second.gateway.stop();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);

test("a database from before connections keeps its sessions as they were", async () => {
	const dir = tempDir("acpantenna-connect-migrate-");
	const statePath = join(dir, "state.sqlite");
	const old = new Database(statePath, { create: true });

	// The sessions table as the first release made it.
	old.run(`
      create table sessions (
        channel_id text not null,
        session_key text not null,
        agent_id text not null,
        acp_session_id text not null,
        conversation_id text not null,
        updated_at text not null,
        primary key (channel_id, session_key)
      )
    `);
	old
		.query("insert into sessions values (?, ?, ?, ?, ?, ?)")
		.run(
			"chat",
			"chat:conversation:room-1",
			"dumb",
			"session-from-before",
			"room-1",
			new Date().toISOString(),
		);
	old.close();

	try {
		const harness = await startHarness({
			statePath,
			channelAgentArgs: ["--resume", "--echo-context"],
		});

		try {
			expect(await harness.ask("hi")).toBe(
				`[session-from-before ${repoRoot}] channel agent: hi`,
			);
			expect(await harness.gateway.listConnections()).toEqual([]);
			expect(await harness.gateway.listSessions()).toEqual([
				expect.not.objectContaining({ connection: expect.anything() }),
			]);
		} finally {
			await harness.gateway.stop();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);

test("refuses to connect a conversation of a channel that keys sessions by sender", async () => {
	const harness = await startHarness({
		channel: { session: { strategy: "perSender" } },
	});

	try {
		await expect(
			harness.gateway.connect({
				channelId: "chat",
				conversationId: "room-1",
				agentId: "connected",
			}),
		).rejects.toThrow("keys its sessions by sender");
		await expect(
			harness.gateway.connect({
				channelId: "nowhere",
				conversationId: "room-1",
				agentId: "connected",
			}),
		).rejects.toThrow('There is no channel "nowhere"');
		await expect(
			harness.gateway.connect({
				channelId: "chat",
				conversationId: "room-1",
				agentId: "nobody",
			}),
		).rejects.toThrow('There is no agent "nobody"');
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

const silentLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};
