#!/usr/bin/env bun

/// <reference types="bun" />

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	ChannelCapabilities,
	ChannelFactory,
	ChannelInboundEvent,
	ChannelOutboundMessage,
} from "@acpantenna/channel";
import { createTextInboundEvent } from "@acpantenna/channel";
import { normalizeConfig } from "@acpantenna/config";
import { AcpAntennaGateway } from "@acpantenna/core";

const repoRoot = resolve(import.meta.dir, "..");
const dumbClientPath = join(
	repoRoot,
	"packages",
	"acp-dumb-client",
	"src",
	"main.ts",
);

interface Harness {
	gateway: AcpAntennaGateway;
	sends: ChannelOutboundMessage[];
	say(text: string, conversationId?: string): Promise<void>;
	answer(interactionId: string, optionId: string): Promise<void>;
}

async function startHarness(options: {
	agentArgs: string[];
	capabilities?: ChannelCapabilities;
	channel?: Record<string, unknown>;
	defaults?: Record<string, unknown>;
	statePath?: string;
}): Promise<Harness> {
	const sends: ChannelOutboundMessage[] = [];
	let emit: ((event: ChannelInboundEvent) => Promise<void> | void) | undefined;

	const factory: ChannelFactory<unknown> = () => ({
		manifest: {
			type: "chat",
			name: "Chat",
			version: "0.0.0",
			capabilities: options.capabilities ?? {},
		},
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
				args: [dumbClientPath, ...options.agentArgs],
				cwd: repoRoot,
			},
		},
		defaults: options.defaults,
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
		logger: silentLogger,
	});

	await gateway.start();

	const send = async (event: ChannelInboundEvent) => {
		if (!emit) {
			throw new Error("channel not started");
		}

		await emit(event);
	};

	return {
		gateway,
		sends,
		say: (text, conversationId = "room-1") =>
			send(createTextInboundEvent({ text, conversationId, senderId: "u1" })),
		answer: (interactionId, optionId) => {
			const event = createTextInboundEvent({
				text: "",
				conversationId: "room-1",
				senderId: "u1",
			});
			event.interaction = { id: interactionId, optionId };
			return send(event);
		},
	};
}

test("delivers text the agent pushes between turns as one message", async () => {
	const harness = await startHarness({
		agentArgs: ["--push-after-turn", "the build is green"],
	});

	try {
		await harness.say("hi");
		const push = await waitFor(() =>
			harness.sends.find((message) => message.origin === "push"),
		);

		// Two chunks, coalesced; the second carried `final`, so it went out
		// without waiting for the idle timer.
		expect(push.text).toBe("the build is green");
		expect(harness.sends.map((message) => message.text)).toEqual([
			"dumb client: hi",
			"the build is green",
		]);
		expect(harness.sends[0]?.origin).toBe("turn");
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

test("routes a permission asked between turns to the conversation, with buttons", async () => {
	const harness = await startHarness({
		agentArgs: ["--push-permission"],
		capabilities: { buttons: true },
		channel: { permissions: { inbound: { mode: "open" }, toolCalls: "ask" } },
	});

	try {
		await harness.say("hi");
		const prompt = await waitFor(() =>
			harness.sends.find((message) => message.interaction),
		);

		expect(prompt.origin).toBe("push");
		expect(prompt.text).toBe("🔒 Ship it?");
		expect(prompt.interaction).toMatchObject({
			kind: "permission",
			message: "Ship it?",
			options: [
				{ id: "yes", label: "Yes", kind: "allow" },
				{ id: "no", label: "No", kind: "reject" },
			],
			toolCall: { id: "question-1", title: "Ship it?", kind: "other" },
		});

		await harness.answer(prompt.interaction?.id ?? "", "yes");

		const outcome = await waitFor(() =>
			harness.sends.find((message) =>
				message.text?.startsWith("permission outcome"),
			),
		);
		expect(outcome.text).toBe("permission outcome: yes");
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

test("rejects an out-of-turn permission when nobody answers in time", async () => {
	const harness = await startHarness({
		agentArgs: ["--push-permission"],
		channel: {
			permissions: {
				inbound: { mode: "open" },
				toolCalls: "ask",
				interactionTimeoutSeconds: 0.2,
			},
		},
	});

	try {
		await harness.say("hi");
		const prompt = await waitFor(() =>
			harness.sends.find((message) => message.interaction),
		);

		// No buttons: the choices are in the text, and no structured options.
		expect(prompt.text).toContain("Reply to interaction");
		expect(prompt.text).toContain("yes (Yes)");
		expect(prompt.interaction?.options).toBeUndefined();

		const outcome = await waitFor(() =>
			harness.sends.find((message) =>
				message.text?.startsWith("permission outcome"),
			),
		);
		expect(outcome.text).toBe("permission outcome: no");
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

test("rehydrates stored sessions on start so pushes reach them, without replaying history", async () => {
	const tempRoot = join(repoRoot, "out");
	mkdirSync(tempRoot, { recursive: true });
	const tempDir = mkdtempSync(join(tempRoot, "acpantenna-rehydrate-"));
	const statePath = join(tempDir, "state.sqlite");
	const agentArgs = [
		"--load-session",
		"--replay",
		"--push-on-load",
		"welcome back",
	];

	try {
		const first = await startHarness({ agentArgs, statePath });
		try {
			await first.say("hi");
			expect(first.sends.map((message) => message.text)).toEqual([
				"dumb client: hi",
			]);
		} finally {
			await first.gateway.stop();
		}

		// Nobody writes after the restart; the push still arrives.
		const second = await startHarness({ agentArgs, statePath });
		try {
			const push = await waitFor(() =>
				second.sends.find((message) => message.text === "welcome back"),
			);
			expect(push.origin).toBe("push");
			await second.gateway.drain();
			await Bun.sleep(100);
			expect(second.sends.map((message) => message.text)).toEqual([
				"welcome back",
			]);

			const status = await second.gateway.status();
			expect(status.agents.dumb?.state).toBe("up");
		} finally {
			await second.gateway.stop();
		}

		// With rehydration off, the agent is not even started until someone
		// writes, and the history a load replays stays out of the reply.
		const third = await startHarness({
			agentArgs,
			statePath,
			defaults: { session: { rehydrateOnStart: false } },
		});
		try {
			await third.gateway.drain();
			expect((await third.gateway.status()).agents.dumb?.state).toBe("idle");

			await third.say("again");
			const reply = await waitFor(() =>
				third.sends.find((message) => message.origin === "turn"),
			);
			expect(reply.text).toBe("dumb client: again");
			expect(
				third.sends.some((message) => message.text?.includes("old answer")),
			).toBe(false);
		} finally {
			await third.gateway.stop();
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}, 30_000);

test("sends tool calls and thoughts as events, never as reply text", async () => {
	const harness = await startHarness({
		agentArgs: ["--thoughts-and-tools"],
		capabilities: { toolCalls: true, thoughts: true },
	});

	try {
		await harness.say("hi");

		expect(
			harness.sends.map((message) => message.event ?? message.text),
		).toEqual([
			{ type: "thought", text: "thinking it over" },
			{
				type: "toolCall",
				update: false,
				toolCall: {
					id: "tool-1",
					title: "dumb.lookup",
					kind: "read",
					status: "pending",
				},
			},
			{
				type: "toolCall",
				update: true,
				toolCall: {
					id: "tool-1",
					title: "dumb.lookup",
					kind: "read",
					status: "completed",
				},
			},
			"dumb client: hi",
		]);
	} finally {
		await harness.gateway.stop();
	}

	// A channel that declares neither gets the reply and nothing else.
	const plain = await startHarness({ agentArgs: ["--thoughts-and-tools"] });

	try {
		await plain.say("hi");
		expect(plain.sends.map((message) => message.text)).toEqual([
			"dumb client: hi",
		]);
	} finally {
		await plain.gateway.stop();
	}
}, 15_000);

test("answers /mode and /new in core without prompting the agent", async () => {
	const harness = await startHarness({ agentArgs: ["--modes"] });

	try {
		await harness.say("/mode trusted");
		await harness.gateway.drain();
		await harness.say("hi");
		await harness.say("/mode");
		await harness.say("/mode bogus");
		await harness.gateway.drain();
		await harness.say("/new");
		await harness.gateway.drain();
		await harness.say("hi");

		const texts = harness.sends.map((message) => message.text);

		expect(texts[0]).toBe("Mode set to trusted.");
		expect(texts[1]).toBe("[trusted] dumb client: hi");
		expect(texts[2]).toBe("Usage: /mode <id>. Modes: ask, trusted.");
		expect(texts[3]).toStartWith("⚠️ Could not set mode bogus:");
		expect(texts[4]).toBe("Started a new session.");
		// A fresh session starts back in the agent's default mode.
		expect(texts[5]).toBe("[ask] dumb client: hi");

		const sessions = await harness.gateway.listSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.acpSessionId).toBe("dumb-session-2");
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

test("/cancel cancels the live turn", async () => {
	const harness = await startHarness({
		agentArgs: ["--wait-for-cancel"],
		channel: {
			intake: { mode: "ackFast" },
			delivery: { mode: "streamChunks" },
		},
	});

	try {
		await harness.say("/cancel");
		await waitFor(() =>
			harness.sends.find((message) => message.text === "Nothing to cancel."),
		);

		await harness.say("hold on");
		await waitFor(() =>
			harness.sends.find((message) => message.text === "waiting for /cancel"),
		);
		await harness.say("/cancel");
		await waitFor(() =>
			harness.sends.find(
				(message) => message.text === "Cancelled the current turn.",
			),
		);
		await harness.gateway.drain();

		// The turn ended `cancelled`: no error, no notice.
		expect(harness.sends.map((message) => message.text)).toEqual([
			"Nothing to cancel.",
			"waiting for /cancel",
			"Cancelled the current turn.",
		]);
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

test("GET /status reports channels and the agent process", async () => {
	const harness = await startHarness({ agentArgs: [] });

	try {
		const before = await (
			await harness.gateway.fetch(new Request("http://acpantenna.test/status"))
		).json();
		expect(before).toEqual({
			ok: true,
			channels: { chat: { type: "chat", state: "ready" } },
			agents: { dumb: { state: "idle" } },
		});

		await harness.say("hi");

		const after = await harness.gateway.status();
		expect(after.agents.dumb?.state).toBe("up");
	} finally {
		await harness.gateway.stop();
	}
}, 15_000);

async function waitFor<T>(
	fn: () => T | undefined | Promise<T | undefined>,
	timeoutMs = 5000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const value = await fn();

		if (value) {
			return value;
		}

		await Bun.sleep(10);
	}

	throw new Error("waitFor timed out");
}

const silentLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};
