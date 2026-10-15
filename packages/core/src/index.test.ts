import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	AcpAgentCapabilities,
	AcpClient,
	AcpPromptRequest,
	AcpPromptResult,
	AcpSessionRequest,
	AcpSessionResult,
	AcpSessionUpdateListener,
	CreateElicitationResponse,
	ElicitationRequestHandler,
	PermissionRequestHandler,
	RequestPermissionResponse,
} from "@acpantenna/acp";
import type {
	ChannelAck,
	ChannelCapabilities,
	ChannelFactory,
	ChannelInboundEvent,
	ChannelOutboundMessage,
} from "@acpantenna/channel";
import { createTextInboundEvent } from "@acpantenna/channel";
import { createWebhookChannel } from "@acpantenna/channel-webhook";
import { normalizeConfig } from "@acpantenna/config";
import { createTelemetry } from "@acpantenna/observability";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
	AcpAntennaGateway,
	channelStateDir,
	isMappingExpired,
	isWithinDays,
	parseReservedCommand,
	resolveMcpServers,
	resolveSessionKey,
	type SessionMapping,
	SqliteStateStore,
	selectPermissionOptionId,
	stopReasonNotice,
} from "./index.ts";

test("resolves per-conversation session keys", () => {
	const event = createTextInboundEvent({
		text: "hello",
		conversationId: "thread-1",
		senderId: "user-1",
	});

	expect(
		resolveSessionKey("webhook", event, { strategy: "perConversation" }),
	).toBe("webhook:conversation:thread-1");
});

test("resolves manual session key templates", () => {
	const event = createTextInboundEvent({
		text: "hello",
		conversationId: "thread-1",
		senderId: "user-1",
	});

	expect(
		resolveSessionKey("webhook", event, {
			strategy: "manualKeyTemplate",
			keyTemplate: "{channel}/{conversation}/{sender}",
		}),
	).toBe("webhook/thread-1/user-1");
});

test("routes webhook events through ACP and back to channel outbox", async () => {
	const fakeClient = new FakeAcpClient();
	const config = normalizeConfig({
		agents: {
			default: {
				command: "fake-agent",
			},
		},
		channels: {
			webhook: {
				type: "webhook",
				permissions: {
					inbound: {
						mode: "open",
					},
				},
			},
		},
		state: {
			driver: "memory",
		},
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: {
			webhook: createWebhookChannel,
		},
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		const response = await gateway.fetch(
			new Request("http://acpantenna.test/channels/webhook/events", {
				method: "POST",
				body: JSON.stringify({
					text: "hello agent",
					senderId: "user-1",
					conversationId: "thread-1",
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(fakeClient.prompts[0]?.sessionId).toBe("fake-session-1");
		expect(fakeClient.prompts[0]?.prompt).toEqual([
			{ type: "text", text: "hello agent" },
		]);

		const outboxResponse = await gateway.fetch(
			new Request("http://acpantenna.test/channels/webhook/outbox"),
		);
		const outbox = (await outboxResponse.json()) as {
			messages: Array<{ conversationId: string; text?: string }>;
		};

		expect(outbox.messages[0]).toMatchObject({
			conversationId: "thread-1",
			text: "hello from fake ACP",
		});
	} finally {
		await gateway.stop();
	}
});

test("serializes prompts for the same channel session", async () => {
	const fakeClient = new FakeAcpClient({ promptDelayMs: 25 });
	const config = normalizeConfig({
		agents: {
			default: {
				command: "fake-agent",
			},
		},
		channels: {
			webhook: {
				type: "webhook",
				permissions: {
					inbound: {
						mode: "open",
					},
				},
			},
		},
		state: {
			driver: "memory",
		},
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: {
			webhook: createWebhookChannel,
		},
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await Promise.all([
			postWebhookEvent(gateway, "first"),
			postWebhookEvent(gateway, "second"),
		]);

		expect(fakeClient.sessionsCreated).toBe(1);
		expect(fakeClient.maxConcurrentPrompts).toBe(1);
		expect(fakeClient.prompts.map((prompt) => prompt.prompt)).toEqual([
			[{ type: "text", text: "first" }],
			[{ type: "text", text: "second" }],
		]);
	} finally {
		await gateway.stop();
	}
});

test("keeps separate channel sessions independent", async () => {
	const fakeClient = new FakeAcpClient({ promptDelayMs: 25 });
	const config = normalizeConfig({
		agents: {
			default: {
				command: "fake-agent",
			},
		},
		channels: {
			webhook: {
				type: "webhook",
				permissions: {
					inbound: {
						mode: "open",
					},
				},
			},
		},
		state: {
			driver: "memory",
		},
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: {
			webhook: createWebhookChannel,
		},
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await Promise.all([
			postWebhookEvent(gateway, "first", "thread-1"),
			postWebhookEvent(gateway, "second", "thread-2"),
		]);

		expect(fakeClient.sessionsCreated).toBe(2);
		expect(fakeClient.maxConcurrentPrompts).toBe(2);
	} finally {
		await gateway.stop();
	}
});

test("authenticates the agent before creating a session when configured", async () => {
	const fakeClient = new FakeAcpClient({ authMethodId: "api-key" });
	const config = normalizeConfig({
		agents: {
			default: {
				command: "fake-agent",
				auth: { methodId: "api-key" },
			},
		},
		channels: {
			webhook: {
				type: "webhook",
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		const response = await postWebhookEvent(gateway, "hello");

		expect(response.status).toBe(200);
		expect(fakeClient.authenticateCalls).toEqual(["api-key"]);
		expect(fakeClient.sessionsCreated).toBe(1);
	} finally {
		await gateway.stop();
	}
});

test("surfaces a clear error when the agent requires auth but none is configured", async () => {
	const fakeClient = new FakeAcpClient({ authMethodId: "api-key" });
	const config = normalizeConfig({
		agents: {
			default: {
				command: "fake-agent",
			},
		},
		channels: {
			webhook: {
				type: "webhook",
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");
		await gateway.drain();

		// The turn is processed durably: the error is captured (not thrown to the
		// caller) and surfaced back to the channel.
		const texts = (await readOutbox(gateway)).messages.map((m) => m.text);
		expect(texts.some((t) => t?.includes("requires authentication"))).toBe(
			true,
		);
		expect(fakeClient.sessionsCreated).toBe(0);

		const failed = (await gateway.listEvents()).filter(
			(e) => e.status === "failed",
		);
		expect(failed).toHaveLength(1);
	} finally {
		await gateway.stop();
	}
});

test("creates a fresh session after a restart when the agent cannot resume or load", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acpantenna-reconnect-"));
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: { type: "webhook", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "sqlite", path: join(dir, "state.sqlite") },
	});

	try {
		const first = new FakeAcpClient();
		const gateway1 = new AcpAntennaGateway({
			config,
			channelFactories: { webhook: createWebhookChannel },
			acpClientFactory: () => first,
		});

		await gateway1.start();
		try {
			await postWebhookEvent(gateway1, "first");
			expect(first.sessionsCreated).toBe(1);
		} finally {
			await gateway1.stop();
		}

		// A fresh client models a restarted agent that has never heard of the
		// session id persisted in the shared SQLite store.
		const second = new FakeAcpClient();
		const gateway2 = new AcpAntennaGateway({
			config,
			channelFactories: { webhook: createWebhookChannel },
			acpClientFactory: () => second,
		});

		await gateway2.start();
		try {
			await postWebhookEvent(gateway2, "second");
			expect(second.sessionsCreated).toBe(1);
			expect(second.prompts).toHaveLength(1);
		} finally {
			await gateway2.stop();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resumes a persisted session after a restart when the agent supports resume", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acpantenna-reconnect-"));
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: { type: "webhook", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "sqlite", path: join(dir, "state.sqlite") },
	});

	try {
		const first = new FakeAcpClient({ supportsResume: true });
		const gateway1 = new AcpAntennaGateway({
			config,
			channelFactories: { webhook: createWebhookChannel },
			acpClientFactory: () => first,
		});

		await gateway1.start();
		try {
			await postWebhookEvent(gateway1, "first");
			expect(first.sessionsCreated).toBe(1);
		} finally {
			await gateway1.stop();
		}

		const second = new FakeAcpClient({ supportsResume: true });
		const gateway2 = new AcpAntennaGateway({
			config,
			channelFactories: { webhook: createWebhookChannel },
			acpClientFactory: () => second,
		});

		await gateway2.start();
		try {
			await postWebhookEvent(gateway2, "second");
			expect(second.resumeCalls).toEqual(["fake-session-1"]);
			expect(second.sessionsCreated).toBe(0);
			expect(second.prompts).toHaveLength(1);
		} finally {
			await gateway2.stop();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("maps abnormal stop reasons to a notice and normal ones to nothing", () => {
	expect(stopReasonNotice("refusal")).toMatch(/declined/);
	expect(stopReasonNotice("max_tokens")).toMatch(/token limit/);
	expect(stopReasonNotice("max_turn_requests")).toMatch(/requests/);
	expect(stopReasonNotice("end_turn")).toBeUndefined();
	expect(stopReasonNotice("cancelled")).toBeUndefined();
});

test("delivers a channel notice when a prompt turn stops abnormally", async () => {
	const fakeClient = new FakeAcpClient({ stopReason: "refusal" });
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: { type: "webhook", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");
		const texts = (await readOutbox(gateway)).messages.map(
			(message) => message.text,
		);

		expect(texts).toContain("hello from fake ACP");
		expect(texts.some((text) => text?.includes("declined to respond"))).toBe(
			true,
		);
	} finally {
		await gateway.stop();
	}
});

test("delivers no extra notice on a normal end_turn", async () => {
	const fakeClient = new FakeAcpClient();
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: { type: "webhook", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");
		const texts = (await readOutbox(gateway)).messages.map(
			(message) => message.text,
		);

		expect(texts).toEqual(["hello from fake ACP"]);
	} finally {
		await gateway.stop();
	}
});

test("treats sessions as expired only past a positive TTL", () => {
	const base = Date.parse("2026-07-01T00:00:00.000Z");

	expect(isMappingExpired("2026-07-01T00:00:00.000Z", 60, base + 30_000)).toBe(
		false,
	);
	expect(isMappingExpired("2026-07-01T00:00:00.000Z", 60, base + 61_000)).toBe(
		true,
	);
	expect(
		isMappingExpired("2026-07-01T00:00:00.000Z", undefined, base + 1e9),
	).toBe(false);
	expect(isMappingExpired("not-a-date", 60, base)).toBe(true);
});

test("sweep closes idle sessions and clears state when the agent supports close", async () => {
	const fakeClient = new FakeAcpClient({ supportsClose: true });
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: {
				type: "webhook",
				session: { idleTtlSeconds: 60 },
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");
		const created = await gateway.listSessions();
		expect(created).toHaveLength(1);
		const acpSessionId = created[0]!.acpSessionId;

		// Sweep far enough in the future that the TTL has elapsed.
		await gateway.sweepIdleSessions(Date.now() + 120_000);

		expect(fakeClient.closeCalls).toEqual([acpSessionId]);
		expect(await gateway.listSessions()).toHaveLength(0);
	} finally {
		await gateway.stop();
	}
});

test("sweep drops idle state without calling close when the agent lacks the capability", async () => {
	const fakeClient = new FakeAcpClient();
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: {
				type: "webhook",
				session: { idleTtlSeconds: 60 },
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");
		await gateway.sweepIdleSessions(Date.now() + 120_000);

		expect(fakeClient.closeCalls).toEqual([]);
		expect(await gateway.listSessions()).toHaveLength(0);
	} finally {
		await gateway.stop();
	}
});

test("sweep leaves sessions without a configured TTL untouched", async () => {
	const fakeClient = new FakeAcpClient({ supportsClose: true });
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: { type: "webhook", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");
		await gateway.sweepIdleSessions(Date.now() + 1e9);

		expect(fakeClient.closeCalls).toEqual([]);
		expect(await gateway.listSessions()).toHaveLength(1);
	} finally {
		await gateway.stop();
	}
});

test("emits correlated spans for a prompt turn", async () => {
	const exporter = new InMemorySpanExporter();
	const telemetry = createTelemetry({
		spanExporter: exporter,
		setGlobal: true,
	});
	const fakeClient = new FakeAcpClient();
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: { type: "webhook", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");
		// Let the fire-and-forget outbound delivery span settle.
		await Bun.sleep(10);
		await telemetry.forceFlush();

		const spans = exporter.getFinishedSpans();
		const names = spans.map((span) => span.name);

		expect(names).toContain("acp.initialize");
		expect(names).toContain("acp.session.new");
		expect(names).toContain("acp.prompt.turn");
		expect(names).toContain("delivery.send");

		const promptSpan = spans.find((span) => span.name === "acp.prompt.turn");
		expect(promptSpan?.attributes["acp.stop_reason"]).toBe("end_turn");
		expect(promptSpan?.attributes["acpantenna.channel_id"]).toBe("webhook");
		expect(promptSpan?.attributes["acpantenna.acp_session_id"]).toBe(
			"fake-session-1",
		);
		expect(promptSpan?.attributes["acpantenna.prompt_cycle_id"]).toBeDefined();
	} finally {
		await gateway.stop();
		await telemetry.shutdown();
		trace.disable();
	}
});

test("buffers chunks into one message per turn by default", async () => {
	const fakeClient = new FakeAcpClient({ chunks: ["Hel", "lo, ", "world"] });
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: { type: "webhook", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");
		const texts = (await readOutbox(gateway)).messages.map((m) => m.text);

		expect(texts).toEqual(["Hello, world"]);
	} finally {
		await gateway.stop();
	}
});

test("streams each chunk as its own message when delivery mode is streamChunks", async () => {
	const fakeClient = new FakeAcpClient({ chunks: ["Hel", "lo, ", "world"] });
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: {
				type: "webhook",
				delivery: { mode: "streamChunks" },
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");
		// Streamed chunks are delivered via the fire-and-forget update path.
		await Bun.sleep(10);
		const texts = (await readOutbox(gateway)).messages.map((m) => m.text);

		expect(texts).toEqual(["Hel", "lo, ", "world"]);
	} finally {
		await gateway.stop();
	}
});

test("journals an inbound event and removes it after successful processing", async () => {
	const fakeClient = new FakeAcpClient();
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: { type: "webhook", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");

		expect((await readOutbox(gateway)).messages).toHaveLength(1);
		expect(await gateway.listEvents()).toHaveLength(0);
	} finally {
		await gateway.stop();
	}
});

test("ackFast returns before the turn completes and delivers asynchronously", async () => {
	const fakeClient = new FakeAcpClient({ promptDelayMs: 50 });
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: {
				type: "webhook",
				intake: { mode: "ackFast" },
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");
		// The POST returned, but the 50ms turn has not produced output yet.
		expect((await readOutbox(gateway)).messages).toHaveLength(0);

		await gateway.drain();
		expect((await readOutbox(gateway)).messages.map((m) => m.text)).toEqual([
			"hello from fake ACP",
		]);
	} finally {
		await gateway.stop();
	}
});

test("recovers and processes a pending event left in the store after a crash", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acpantenna-recovery-"));
	const statePath = join(dir, "state.sqlite");
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: { type: "webhook", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "sqlite", path: statePath },
	});

	try {
		// Simulate a crash: an event persisted as "received" but never processed.
		const seed = new SqliteStateStore(statePath);
		const event = createTextInboundEvent({
			id: "evt-1",
			text: "hello",
			conversationId: "demo",
			senderId: "u1",
		});
		const now = new Date().toISOString();
		await seed.saveEvent({
			id: "evt-1",
			channelId: "webhook",
			sessionKey: "webhook:conversation:demo",
			status: "received",
			event,
			attempts: 0,
			createdAt: now,
			updatedAt: now,
		});
		seed.close();

		const fakeClient = new FakeAcpClient();
		const gateway = new AcpAntennaGateway({
			config,
			channelFactories: { webhook: createWebhookChannel },
			acpClientFactory: () => fakeClient,
		});

		await gateway.start();
		try {
			await gateway.drain();

			expect(fakeClient.prompts.map((p) => p.prompt)).toEqual([
				[{ type: "text", text: "hello" }],
			]);
			expect((await readOutbox(gateway)).messages.map((m) => m.text)).toEqual([
				"hello from fake ACP",
			]);
			expect(await gateway.listEvents()).toHaveLength(0);
		} finally {
			await gateway.stop();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("derives the outbound message id from the event id", async () => {
	const channel = createRecordingChannel();
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: { type: "test", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		acpClientFactory: () => new FakeAcpClient(),
	});

	await gateway.start();

	try {
		await channel.emit(
			createTextInboundEvent({
				id: "evt-abc",
				text: "hi",
				conversationId: "c1",
				senderId: "u1",
			}),
		);
		await gateway.drain();

		expect(channel.sends[0]?.id).toBe("evt-abc:message");
	} finally {
		await gateway.stop();
	}
});

test("a replayed event does not double-deliver to an idempotent channel", async () => {
	const channel = createRecordingChannel([], { dedupe: true });
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: { type: "test", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		acpClientFactory: () => new FakeAcpClient(),
	});

	await gateway.start();

	try {
		const event = createTextInboundEvent({
			id: "evt-1",
			text: "hi",
			conversationId: "c1",
			senderId: "u1",
		});

		await channel.emit(event);
		await gateway.drain();
		// Replay the same event (as recovery would): the outbound id is identical,
		// so the idempotent channel de-dupes it.
		await channel.emit(event);
		await gateway.drain();

		expect(channel.sends.map((m) => m.text)).toEqual(["hello from fake ACP"]);
	} finally {
		await gateway.stop();
	}
});

test("selects reject/allow options by kind, preferring the once variant", () => {
	const options = [
		{ optionId: "allow", kind: "allow_once" },
		{ optionId: "allowAll", kind: "allow_always" },
		{ optionId: "deny", kind: "reject_once" },
	];

	expect(selectPermissionOptionId(options, "reject")).toBe("deny");
	expect(selectPermissionOptionId(options, "allow")).toBe("allow");
	expect(
		selectPermissionOptionId(
			[{ optionId: "x", kind: "reject_always" }],
			"reject",
		),
	).toBe("x");
	expect(
		selectPermissionOptionId([{ optionId: "x", kind: "allow_once" }], "reject"),
	).toBeUndefined();
});

const PERMISSION_OPTIONS = [
	{ optionId: "allow", kind: "allow_once" },
	{ optionId: "deny", kind: "reject_once" },
];

function permissionGateway(
	toolCalls: "deny" | "allowTrusted" | "ask",
	channel: RecordingChannel,
	fakeClient: FakeAcpClient,
	extra: { intake?: "ackFast"; interactionTimeoutSeconds?: number } = {},
): AcpAntennaGateway {
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: {
				type: "test",
				intake: extra.intake ? { mode: extra.intake } : undefined,
				permissions: {
					inbound: { mode: "open" },
					toolCalls,
					interactionTimeoutSeconds: extra.interactionTimeoutSeconds,
				},
			},
		},
		state: { driver: "memory" },
	});

	return new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		acpClientFactory: () => fakeClient,
	});
}

test("deny policy selects a reject option", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({
		permissionOptions: PERMISSION_OPTIONS,
	});
	const gateway = permissionGateway("deny", channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go"));
		await gateway.drain();

		expect(fakeClient.permissionOutcome).toEqual({
			outcome: { outcome: "selected", optionId: "deny" },
		});
	} finally {
		await gateway.stop();
	}
});

test("deny policy cancels when no reject option is offered", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({
		permissionOptions: [{ optionId: "allow", kind: "allow_once" }],
	});
	const gateway = permissionGateway("deny", channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go"));
		await gateway.drain();

		expect(fakeClient.permissionOutcome).toEqual({
			outcome: { outcome: "cancelled" },
		});
	} finally {
		await gateway.stop();
	}
});

test("allowTrusted allows a trusted sender and rejects an untrusted one", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({
		permissionOptions: PERMISSION_OPTIONS,
	});
	const gateway = permissionGateway("allowTrusted", channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(
			createTextInboundEvent({
				text: "go",
				conversationId: "trusted",
				senderId: "u1",
				trusted: true,
			}),
		);
		await gateway.drain();
		expect(fakeClient.permissionOutcome).toEqual({
			outcome: { outcome: "selected", optionId: "allow" },
		});

		await channel.emit(
			createTextInboundEvent({
				text: "go",
				conversationId: "untrusted",
				senderId: "u2",
			}),
		);
		await gateway.drain();
		expect(fakeClient.permissionOutcome).toEqual({
			outcome: { outcome: "selected", optionId: "deny" },
		});
	} finally {
		await gateway.stop();
	}
});

test("ask presents an interaction and resolves it from the channel response", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({
		permissionOptions: PERMISSION_OPTIONS,
	});
	const gateway = permissionGateway("ask", channel, fakeClient, {
		intake: "ackFast",
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go", "c1"));

		const prompt = await waitFor(() =>
			channel.sends.find((message) => message.interaction),
		);
		const interactionId = prompt.interaction?.id ?? "";
		expect(interactionId).toBeTruthy();

		const response = createTextInboundEvent({
			text: "",
			conversationId: "c1",
			senderId: "u1",
		});
		response.interaction = { id: interactionId, optionId: "allow" };
		await channel.emit(response);
		await gateway.drain();

		expect(fakeClient.permissionOutcome).toEqual({
			outcome: { outcome: "selected", optionId: "allow" },
		});
	} finally {
		await gateway.stop();
	}
});

test("ask denies when the interaction times out", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({
		permissionOptions: PERMISSION_OPTIONS,
	});
	const gateway = permissionGateway("ask", channel, fakeClient, {
		intake: "ackFast",
		interactionTimeoutSeconds: 0.1,
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go", "c1"));
		await gateway.drain();

		expect(fakeClient.permissionOutcome).toEqual({
			outcome: { outcome: "selected", optionId: "deny" },
		});
	} finally {
		await gateway.stop();
	}
});

const FORM_ELICITATION = {
	mode: "form",
	message: "What is your name?",
	requestedSchema: {
		type: "object",
		properties: { name: { type: "string" } },
		required: ["name"],
	},
};

test("elicitation presents a form and accepts content from the channel", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({ elicitation: FORM_ELICITATION });
	const gateway = permissionGateway("deny", channel, fakeClient, {
		intake: "ackFast",
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go", "c1"));

		const prompt = await waitFor(() =>
			channel.sends.find(
				(message) => message.interaction?.kind === "elicitation",
			),
		);
		const interactionId = prompt.interaction?.id ?? "";
		expect(interactionId).toBeTruthy();
		expect(prompt.interaction?.fields).toEqual([
			{ name: "name", type: "string", required: true },
		]);

		const response = createTextInboundEvent({
			text: "",
			conversationId: "c1",
			senderId: "u1",
		});
		response.interaction = { id: interactionId, content: { name: "Ada" } };
		await channel.emit(response);
		await gateway.drain();

		expect(fakeClient.elicitationOutcome).toEqual({
			action: "accept",
			content: { name: "Ada" },
		});
	} finally {
		await gateway.stop();
	}
});

test("elicitation declines when the user declines", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({ elicitation: FORM_ELICITATION });
	const gateway = permissionGateway("deny", channel, fakeClient, {
		intake: "ackFast",
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go", "c1"));

		const prompt = await waitFor(() =>
			channel.sends.find(
				(message) => message.interaction?.kind === "elicitation",
			),
		);

		const response = createTextInboundEvent({
			text: "",
			conversationId: "c1",
			senderId: "u1",
		});
		response.interaction = {
			id: prompt.interaction?.id ?? "",
			declined: true,
		};
		await channel.emit(response);
		await gateway.drain();

		expect(fakeClient.elicitationOutcome).toEqual({ action: "decline" });
	} finally {
		await gateway.stop();
	}
});

test("elicitation declines when the interaction times out", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({ elicitation: FORM_ELICITATION });
	const gateway = permissionGateway("deny", channel, fakeClient, {
		intake: "ackFast",
		interactionTimeoutSeconds: 0.1,
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go", "c1"));
		await gateway.drain();

		expect(fakeClient.elicitationOutcome).toEqual({ action: "decline" });
	} finally {
		await gateway.stop();
	}
});

test("elicitation declines url mode without prompting the channel", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({
		elicitation: {
			mode: "url",
			message: "Open this link to continue",
			url: "https://example.com/auth",
		},
	});
	const gateway = permissionGateway("deny", channel, fakeClient, {
		intake: "ackFast",
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go", "c1"));
		await gateway.drain();

		expect(fakeClient.elicitationOutcome).toEqual({ action: "decline" });
		expect(
			channel.sends.find(
				(message) => message.interaction?.kind === "elicitation",
			),
		).toBeUndefined();
	} finally {
		await gateway.stop();
	}
});

async function waitFor<T>(
	fn: () => T | undefined,
	timeoutMs = 2000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const value = fn();

		if (value) {
			return value;
		}

		await Bun.sleep(10);
	}

	throw new Error("waitFor timed out");
}

async function readOutbox(
	gateway: AcpAntennaGateway,
): Promise<{ messages: Array<{ conversationId: string; text?: string }> }> {
	const response = await gateway.fetch(
		new Request("http://acpantenna.test/channels/webhook/outbox"),
	);

	return (await response.json()) as {
		messages: Array<{ conversationId: string; text?: string }>;
	};
}

/** A working directory, absolute on every OS (`D:\\work` on Windows). */
const WORK = resolve("/work");

/** A gateway whose channel uses `default`, with `claude` reachable only by connecting. */
function connectingGateway(
	options: {
		claude?: FakeAcpClient;
		defaultClient?: FakeAcpClient;
		channel?: Record<string, unknown>;
		statePath?: string;
	} = {},
) {
	const claude = options.claude ?? new FakeAcpClient({ supportsResume: true });
	const defaultClient = options.defaultClient ?? new FakeAcpClient();
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			webhook: {
				type: "webhook",
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
		channelFactories: { webhook: createWebhookChannel },
		acpClientFactory: (agentId) =>
			agentId === "claude" ? claude : defaultClient,
		resolveAgent: (agentId) =>
			agentId === "claude" ? { command: "fake-claude" } : undefined,
		logger: silentLogger,
	});

	return { gateway, claude, defaultClient };
}

const thread1 = { channelId: "webhook", conversationId: "thread-1" };

test("connect resumes a session of an agent the config does not name, in the directory given", async () => {
	const { gateway, claude, defaultClient } = connectingGateway();

	await gateway.start();

	try {
		const connection = await gateway.connect({
			...thread1,
			agentId: "claude",
			acpSessionId: "claude-1",
			cwd: WORK,
		});

		expect(connection).toMatchObject({
			sessionKey: "webhook:conversation:thread-1",
			agentId: "claude",
			acpSessionId: "claude-1",
			cwd: WORK,
			connection: true,
		});
		expect(claude.resumeCalls).toEqual(["claude-1"]);
		expect(claude.resumeRequests[0]?.cwd).toBe(WORK);

		await postWebhookEvent(gateway, "to claude");
		await postWebhookEvent(gateway, "to the channel's agent", "thread-2");

		expect(claude.prompts.map((prompt) => prompt.sessionId)).toEqual([
			"claude-1",
		]);
		expect(defaultClient.prompts).toHaveLength(1);
		// Its `updatedAt` moves with each message; the rest is what connect made.
		const { updatedAt: _connectedAt, ...bound } = connection;
		expect(await gateway.listConnections()).toEqual([
			expect.objectContaining(bound),
		]);
	} finally {
		await gateway.stop();
	}
});

test("connect without a session creates one in the directory given", async () => {
	const { gateway, claude } = connectingGateway();

	await gateway.start();

	try {
		const connection = await gateway.connect({
			...thread1,
			agentId: "claude",
			cwd: WORK,
		});

		expect(connection.acpSessionId).toBe("fake-session-1");
		expect(claude.newSessionRequests[0]?.cwd).toBe(WORK);
	} finally {
		await gateway.stop();
	}
});

test("connect forks with session/fork when asked, and refuses when the agent cannot", async () => {
	const { gateway, claude } = connectingGateway({
		claude: new FakeAcpClient({ supportsFork: true }),
	});

	await gateway.start();

	try {
		const connection = await gateway.connect({
			...thread1,
			agentId: "claude",
			acpSessionId: "claude-1",
			fork: true,
			cwd: WORK,
		});

		expect(connection.acpSessionId).toBe("claude-1-fork");
		expect(claude.forkCalls).toEqual([
			{
				sessionId: "claude-1",
				request: expect.objectContaining({ cwd: WORK }),
			},
		]);
		expect(claude.resumeCalls).toEqual([]);
	} finally {
		await gateway.stop();
	}

	const unforkable = connectingGateway();
	await unforkable.gateway.start();

	try {
		await expect(
			unforkable.gateway.connect({
				...thread1,
				agentId: "claude",
				acpSessionId: "claude-1",
				fork: true,
			}),
		).rejects.toThrow('Agent "claude" cannot fork sessions.');
	} finally {
		await unforkable.gateway.stop();
	}
});

test("connect fails, and binds nothing, when the session cannot be resumed", async () => {
	const { gateway } = connectingGateway({ claude: new FakeAcpClient() });

	await gateway.start();

	try {
		await expect(
			gateway.connect({ ...thread1, agentId: "claude", acpSessionId: "gone" }),
		).rejects.toThrow('Agent "claude" could not resume session gone.');
		expect(await gateway.listSessions()).toEqual([]);
	} finally {
		await gateway.stop();
	}
});

test("disconnect cancels the turn, closes the session and stops an agent nothing uses", async () => {
	const { gateway, claude } = connectingGateway({
		claude: new FakeAcpClient({ supportsResume: true, supportsClose: true }),
	});

	await gateway.start();

	try {
		await gateway.connect({
			...thread1,
			agentId: "claude",
			acpSessionId: "claude-1",
		});

		expect(
			await gateway.disconnect({ acpSessionId: "claude-1" }),
		).toMatchObject({ acpSessionId: "claude-1" });
		expect(claude.closeCalls).toEqual(["claude-1"]);
		expect(claude.disposed).toBe(true);
		expect(await gateway.listSessions()).toEqual([]);
		expect((await gateway.status()).agents).toEqual({
			default: { state: "idle" },
		});
		// Nothing to drop is not an error.
		expect(await gateway.disconnect(thread1)).toBeUndefined();
	} finally {
		await gateway.stop();
	}
});

test("disconnect leaves a conversation that was never connected alone", async () => {
	const { gateway, defaultClient } = connectingGateway();

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "hello");

		expect(await gateway.disconnect(thread1)).toBeUndefined();
		expect(await gateway.listSessions()).toHaveLength(1);
		expect(defaultClient.disposed).toBe(false);
	} finally {
		await gateway.stop();
	}
});

test("a connection replaces the conversation's own session and is never swept as idle", async () => {
	const { gateway, defaultClient } = connectingGateway({
		defaultClient: new FakeAcpClient({ supportsClose: true }),
		channel: { session: { idleTtlSeconds: 60 } },
	});

	await gateway.start();

	try {
		await postWebhookEvent(gateway, "before connecting");
		await gateway.connect({
			...thread1,
			agentId: "claude",
			acpSessionId: "claude-1",
		});

		expect(defaultClient.closeCalls).toEqual(["fake-session-1"]);

		await gateway.sweepIdleSessions(Date.now() + 24 * 60 * 60 * 1000);

		expect(await gateway.listConnections()).toHaveLength(1);
	} finally {
		await gateway.stop();
	}
});

test("rehydrates a connection on start, however long it has been quiet", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acpantenna-connection-"));
	const statePath = join(dir, "state.sqlite");
	const store = new SqliteStateStore(statePath);
	const quiet: SessionMapping = {
		channelId: "webhook",
		sessionKey: "webhook:conversation:thread-1",
		agentId: "claude",
		acpSessionId: "claude-1",
		conversationId: "thread-1",
		updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
		cwd: WORK,
		connection: true,
	};

	await store.setSession(quiet);
	store.close();

	const { gateway, claude } = connectingGateway({ statePath });

	try {
		await gateway.start();
		await gateway.drain();

		expect(claude.resumeCalls).toEqual(["claude-1"]);
		expect(claude.resumeRequests[0]?.cwd).toBe(WORK);
	} finally {
		await gateway.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/new in a connected conversation stays with its agent and directory", async () => {
	const { gateway, claude, defaultClient } = connectingGateway();

	await gateway.start();

	try {
		await gateway.connect({
			...thread1,
			agentId: "claude",
			acpSessionId: "claude-1",
			cwd: WORK,
		});
		await postWebhookEvent(gateway, "/new");
		await gateway.drain();

		expect(claude.newSessionRequests.map((request) => request.cwd)).toEqual([
			WORK,
		]);
		expect(defaultClient.sessionsCreated).toBe(0);
		expect(await gateway.listConnections()).toEqual([
			expect.objectContaining({
				acpSessionId: "fake-session-1",
				cwd: WORK,
				connection: true,
			}),
		]);
	} finally {
		await gateway.stop();
	}
});

test("a sessions table from before connections gains the columns and keeps its rows", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acpantenna-migrate-"));
	const path = join(dir, "state.sqlite");
	const old = new Database(path, { create: true });

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
		.run("webhook", "key", "main", "acp-1", "thread-1", "2026-10-01T00:00:00Z");
	old.close();

	const store = new SqliteStateStore(path);

	try {
		expect(await store.listSessions()).toEqual([
			{
				channelId: "webhook",
				sessionKey: "key",
				agentId: "main",
				acpSessionId: "acp-1",
				conversationId: "thread-1",
				updatedAt: "2026-10-01T00:00:00Z",
			},
		]);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

async function postWebhookEvent(
	gateway: AcpAntennaGateway,
	text: string,
	conversationId = "thread-1",
): Promise<Response> {
	return await gateway.fetch(
		new Request("http://acpantenna.test/channels/webhook/events", {
			method: "POST",
			body: JSON.stringify({
				text,
				senderId: "user-1",
				conversationId,
			}),
		}),
	);
}

interface RecordingChannel {
	factory: ChannelFactory<unknown>;
	sends: ChannelOutboundMessage[];
	emit: (event: ChannelInboundEvent) => Promise<void>;
}

function createRecordingChannel(
	acks: Array<ChannelAck | "throw"> = [],
	options: {
		dedupe?: boolean;
		capabilities?: ChannelCapabilities;
		failStart?: boolean;
	} = {},
): RecordingChannel {
	const sends: ChannelOutboundMessage[] = [];
	const seen = new Set<string>();
	let emitFn:
		| ((event: ChannelInboundEvent) => Promise<void> | void)
		| undefined;
	let sendCount = 0;

	const factory: ChannelFactory<unknown> = () => ({
		manifest: {
			type: "test",
			name: "Test",
			version: "0.0.0",
			capabilities: options.capabilities,
		},
		start(context) {
			if (options.failStart) {
				throw new Error("bad token");
			}

			emitFn = context.emit;
		},
		send(message) {
			// Idempotent channel: drop a message whose id was already delivered.
			if (options.dedupe && message.id !== undefined) {
				if (seen.has(message.id)) {
					return { ok: true, messageId: message.id };
				}

				seen.add(message.id);
			}

			sends.push(message);
			const entry = acks[sendCount] ?? { ok: true, messageId: message.id };
			sendCount += 1;

			if (entry === "throw") {
				throw new Error("send failed");
			}

			return entry;
		},
	});

	return {
		factory,
		sends,
		emit: async (event) => {
			if (!emitFn) {
				throw new Error("recording channel not started");
			}

			await emitFn(event);
		},
	};
}

function inboundEvent(
	text: string,
	conversationId = "c1",
): ChannelInboundEvent {
	return createTextInboundEvent({ text, conversationId, senderId: "u1" });
}

test("retries a failed send with the same id, then succeeds", async () => {
	const channel = createRecordingChannel([
		{ ok: false, retryAfterMs: 0 },
		{ ok: true },
	]);
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: {
				type: "test",
				delivery: { retry: { backoffMs: 0 } },
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		acpClientFactory: () => new FakeAcpClient(),
	});

	await gateway.start();

	try {
		await channel.emit(inboundEvent("hi"));

		expect(channel.sends).toHaveLength(2);
		expect(channel.sends[0]?.text).toBe("hello from fake ACP");
		expect(channel.sends[0]?.id).toBeTruthy();
		expect(channel.sends[0]?.id).toBe(channel.sends[1]?.id);
	} finally {
		await gateway.stop();
	}
});

test("retries a thrown send as transient", async () => {
	const channel = createRecordingChannel(["throw", { ok: true }]);
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: {
				type: "test",
				delivery: { retry: { backoffMs: 0 } },
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		acpClientFactory: () => new FakeAcpClient(),
	});

	await gateway.start();

	try {
		await channel.emit(inboundEvent("hi"));

		expect(channel.sends).toHaveLength(2);
	} finally {
		await gateway.stop();
	}
});

test("does not retry a failure the adapter marks non-retryable", async () => {
	const channel = createRecordingChannel([{ ok: false }]);
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: { type: "test", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		acpClientFactory: () => new FakeAcpClient(),
	});

	await gateway.start();

	try {
		await channel.emit(inboundEvent("hi"));

		expect(channel.sends).toHaveLength(1);
	} finally {
		await gateway.stop();
	}
});

test("stops after the configured maximum attempts", async () => {
	const channel = createRecordingChannel([
		{ ok: false, retryAfterMs: 0 },
		{ ok: false, retryAfterMs: 0 },
		{ ok: false, retryAfterMs: 0 },
		{ ok: false, retryAfterMs: 0 },
	]);
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: {
				type: "test",
				delivery: { retry: { maxAttempts: 3, backoffMs: 0 } },
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		acpClientFactory: () => new FakeAcpClient(),
	});

	await gateway.start();

	try {
		await channel.emit(inboundEvent("hi"));

		expect(channel.sends).toHaveLength(3);
	} finally {
		await gateway.stop();
	}
});

test("debounceChunks flushes each batch after a quiet gap", async () => {
	const channel = createRecordingChannel();
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: {
				type: "test",
				delivery: { mode: "debounceChunks", debounceMs: 5 },
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		// Gaps (40ms) far exceed the debounce window (5ms), so each chunk flushes
		// on its own.
		acpClientFactory: () =>
			new FakeAcpClient({ chunks: ["a", "b", "c"], chunkDelayMs: 40 }),
	});

	await gateway.start();

	try {
		await channel.emit(inboundEvent("hi"));

		expect(channel.sends.map((m) => m.text)).toEqual(["a", "b", "c"]);
	} finally {
		await gateway.stop();
	}
});

test("debounceChunks batches a burst and flushes once at turn end", async () => {
	const channel = createRecordingChannel();
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: {
				type: "test",
				delivery: { mode: "debounceChunks", debounceMs: 50 },
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		// No gaps: chunks arrive together and the turn ends before the debounce
		// window elapses, so the turn-end flush sends one message.
		acpClientFactory: () => new FakeAcpClient({ chunks: ["a", "b", "c"] }),
	});

	await gateway.start();

	try {
		await channel.emit(inboundEvent("hi"));

		expect(channel.sends.map((m) => m.text)).toEqual(["abc"]);
	} finally {
		await gateway.stop();
	}
});

test("sendEvents forwards every update with its raw payload", async () => {
	const channel = createRecordingChannel();
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: {
				type: "test",
				delivery: { mode: "sendEvents" },
				permissions: { inbound: { mode: "open" } },
			},
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		acpClientFactory: () => new FakeAcpClient({ chunks: ["a", "b"] }),
	});

	await gateway.start();

	try {
		await channel.emit(inboundEvent("hi"));

		expect(channel.sends.map((m) => m.text)).toEqual(["a", "b"]);
		expect(channel.sends.every((m) => m.raw !== undefined)).toBe(true);
	} finally {
		await gateway.stop();
	}
});

class FakeAcpClient implements AcpClient {
	public readonly prompts: AcpPromptRequest[] = [];
	public sessionsCreated = 0;
	public maxConcurrentPrompts = 0;
	public authenticated = false;
	public readonly authenticateCalls: string[] = [];
	public readonly resumeCalls: string[] = [];
	public readonly loadCalls: string[] = [];
	public readonly closeCalls: string[] = [];
	public permissionOutcome?: RequestPermissionResponse;
	public elicitationOutcome?: CreateElicitationResponse;
	public readonly newSessionRequests: AcpSessionRequest[] = [];
	public readonly modeCalls: Array<{ sessionId: string; modeId: string }> = [];
	public readonly cancelCalls: string[] = [];
	public readonly resumeRequests: AcpSessionRequest[] = [];
	public readonly forkCalls: Array<{
		sessionId: string;
		request: AcpSessionRequest;
	}> = [];
	public disposed = false;
	public alive = true;
	public connects = 0;
	private readonly exitListeners = new Set<() => void>();
	private readonly listeners = new Set<AcpSessionUpdateListener>();
	private readonly knownSessions = new Set<string>();
	private permissionHandler?: PermissionRequestHandler;
	private elicitationHandler?: ElicitationRequestHandler;
	private activePrompts = 0;

	public constructor(
		private readonly options: {
			promptDelayMs?: number;
			authMethodId?: string;
			stopReason?: AcpPromptResult["stopReason"];
			supportsResume?: boolean;
			supportsLoad?: boolean;
			supportsClose?: boolean;
			supportsFork?: boolean;
			chunks?: string[];
			chunkDelayMs?: number;
			/** Raw `update` objects sent at the start of every turn. */
			updatesDuringTurn?: Array<Record<string, unknown>>;
			permissionOptions?: Array<{ optionId: string; kind?: string }>;
			elicitation?: Record<string, unknown>;
		} = {},
	) {}

	public async connect(): Promise<void> {
		this.connects += 1;
		this.alive = true;
	}

	public isAlive(): boolean {
		return this.alive;
	}

	public onExit(listener: () => void): () => void {
		this.exitListeners.add(listener);

		return () => {
			this.exitListeners.delete(listener);
		};
	}

	/** Simulate the agent process dying: it forgets every session. */
	public exit(): void {
		this.alive = false;
		this.knownSessions.clear();

		for (const listener of this.exitListeners) {
			listener();
		}
	}

	/** Send a `session/update` outside any turn. */
	public async emitUpdate(
		sessionId: string,
		update: Record<string, unknown>,
	): Promise<void> {
		for (const listener of this.listeners) {
			await listener({ sessionId, update });
		}
	}

	/** Ask a permission outside any turn. */
	public async requestPermission(
		params: Record<string, unknown>,
	): Promise<RequestPermissionResponse | undefined> {
		return await this.permissionHandler?.(params);
	}

	public async setSessionMode(
		sessionId: string,
		modeId: string,
	): Promise<void> {
		this.modeCalls.push({ sessionId, modeId });
	}

	public async initialize(): Promise<{ protocolVersion: number }> {
		return { protocolVersion: 1 };
	}

	public supportsResumeSession(): boolean {
		return this.options.supportsResume ?? false;
	}

	public supportsLoadSession(): boolean {
		return this.options.supportsLoad ?? false;
	}

	public getAgentCapabilities(): AcpAgentCapabilities {
		return {
			loadSession: this.options.supportsLoad ?? false,
			resumeSession: this.options.supportsResume ?? false,
			forkSession: false,
			listSessions: false,
			closeSession: this.options.supportsClose ?? false,
			deleteSession: false,
			prompt: { image: false, audio: false, embeddedContext: false },
		};
	}

	public async authenticate(methodId: string): Promise<void> {
		this.authenticateCalls.push(methodId);

		if (methodId === this.options.authMethodId) {
			this.authenticated = true;
		}
	}

	public getAuthMethods(): unknown[] {
		return this.options.authMethodId
			? [{ id: this.options.authMethodId, name: "Test auth" }]
			: [];
	}

	public async newSession(
		request: AcpSessionRequest,
	): Promise<AcpSessionResult> {
		this.newSessionRequests.push(request);

		if (this.options.authMethodId && !this.authenticated) {
			throw Object.assign(new Error("Authentication required"), {
				code: -32000,
			});
		}

		this.sessionsCreated += 1;
		const sessionId = `fake-session-${this.sessionsCreated}`;
		this.knownSessions.add(sessionId);

		return { sessionId };
	}

	public async resumeSession(
		sessionId: string,
		request: AcpSessionRequest,
	): Promise<void> {
		this.resumeCalls.push(sessionId);
		this.resumeRequests.push(request);
		this.knownSessions.add(sessionId);
	}

	public supportsForkSession(): boolean {
		return this.options.supportsFork ?? false;
	}

	public async forkSession(
		sessionId: string,
		request: AcpSessionRequest,
	): Promise<AcpSessionResult> {
		this.forkCalls.push({ sessionId, request });
		const forked = `${sessionId}-fork`;
		this.knownSessions.add(forked);

		return { sessionId: forked };
	}

	public async loadSession(
		sessionId: string,
		_request: AcpSessionRequest,
	): Promise<void> {
		this.loadCalls.push(sessionId);
		this.knownSessions.add(sessionId);
	}

	public async prompt(request: AcpPromptRequest): Promise<AcpPromptResult> {
		if (!this.knownSessions.has(request.sessionId)) {
			throw Object.assign(
				new Error(`Session ${request.sessionId} not found.`),
				{ code: -32602 },
			);
		}

		this.activePrompts += 1;
		this.maxConcurrentPrompts = Math.max(
			this.maxConcurrentPrompts,
			this.activePrompts,
		);
		this.prompts.push(request);

		try {
			for (const update of this.options.updatesDuringTurn ?? []) {
				await this.emitUpdate(request.sessionId, update);
			}

			if (this.options.permissionOptions && this.permissionHandler) {
				this.permissionOutcome = await this.permissionHandler({
					sessionId: request.sessionId,
					options: this.options.permissionOptions,
				});
			}

			if (this.options.elicitation && this.elicitationHandler) {
				this.elicitationOutcome = await this.elicitationHandler({
					sessionId: request.sessionId,
					...this.options.elicitation,
				});
			}

			if (this.options.promptDelayMs) {
				await Bun.sleep(this.options.promptDelayMs);
			}

			const chunks = this.options.chunks ?? ["hello from fake ACP"];

			for (const chunk of chunks) {
				for (const listener of this.listeners) {
					await listener({
						sessionId: request.sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: {
								type: "text",
								text: chunk,
							},
						},
					});
				}

				if (this.options.chunkDelayMs) {
					await Bun.sleep(this.options.chunkDelayMs);
				}
			}
		} finally {
			this.activePrompts -= 1;
		}

		return { stopReason: this.options.stopReason ?? "end_turn" };
	}

	public async cancel(sessionId: string): Promise<void> {
		this.cancelCalls.push(sessionId);
	}

	public async closeSession(sessionId: string): Promise<void> {
		this.closeCalls.push(sessionId);
	}

	public onPermissionRequest(handler: PermissionRequestHandler): () => void {
		this.permissionHandler = handler;

		return () => {
			this.permissionHandler = undefined;
		};
	}

	public onElicitation(handler: ElicitationRequestHandler): () => void {
		this.elicitationHandler = handler;

		return () => {
			this.elicitationHandler = undefined;
		};
	}

	public onSessionUpdate(listener: AcpSessionUpdateListener): () => void {
		this.listeners.add(listener);

		return () => {
			this.listeners.delete(listener);
		};
	}

	public async dispose(): Promise<void> {
		this.disposed = true;
	}
}

function chatGateway(
	channel: RecordingChannel,
	fakeClient: FakeAcpClient,
	channelConfig: Record<string, unknown> = {},
	extraChannels: Record<string, RecordingChannel> = {},
): AcpAntennaGateway {
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent" } },
		channels: {
			test: {
				type: "test",
				permissions: { inbound: { mode: "open" } },
				...channelConfig,
			},
			...Object.fromEntries(
				Object.keys(extraChannels).map((type) => [
					type,
					{ type, permissions: { inbound: { mode: "open" } } },
				]),
			),
		},
		state: { driver: "memory" },
	});

	return new AcpAntennaGateway({
		config,
		channelFactories: {
			test: channel.factory,
			...Object.fromEntries(
				Object.entries(extraChannels).map(([type, extra]) => [
					type,
					extra.factory,
				]),
			),
		},
		acpClientFactory: () => fakeClient,
		logger: silentLogger,
	});
}

const silentLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

function textChunk(text: string, meta?: Record<string, unknown>) {
	return {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
		...(meta ? { _meta: meta } : {}),
	};
}

test("coalesces pushed chunks and sends them after the idle gap", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient();
	const gateway = chatGateway(channel, fakeClient, {
		delivery: { pushIdleMs: 30 },
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));
		await fakeClient.emitUpdate("fake-session-1", textChunk("a"));
		await fakeClient.emitUpdate("fake-session-1", textChunk("b"));

		// Nothing until the agent has been quiet for pushIdleMs.
		expect(channel.sends).toHaveLength(1);

		const push = await waitFor(() => channel.sends[1]);
		expect(push).toMatchObject({ text: "ab", origin: "push" });
	} finally {
		await gateway.stop();
	}
});

test("streamChunks sends each pushed chunk on its own", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient();
	const gateway = chatGateway(channel, fakeClient, {
		delivery: { mode: "streamChunks" },
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));
		await fakeClient.emitUpdate("fake-session-1", textChunk("a"));
		await fakeClient.emitUpdate("fake-session-1", textChunk("b"));
		await gateway.drain();

		expect(channel.sends.slice(1).map((m) => [m.text, m.origin])).toEqual([
			["a", "push"],
			["b", "push"],
		]);
	} finally {
		await gateway.stop();
	}
});

test("a chunk marked as a push mid-turn stays out of the reply", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({
		updatesDuringTurn: [
			textChunk("card: build failed", {
				"acpantenna/push": { final: true, id: "c1" },
			}),
		],
	});
	const gateway = chatGateway(channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));

		expect(channel.sends.map((m) => [m.id, m.text, m.origin])).toEqual([
			["push:c1", "card: build failed", "push"],
			[expect.stringContaining(":message"), "hello from fake ACP", "turn"],
		]);
	} finally {
		await gateway.stop();
	}
});

test("pushed text goes out before a turn that starts while it is pending", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient();
	const gateway = chatGateway(channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));
		await fakeClient.emitUpdate("fake-session-1", textChunk("pending push"));
		await channel.emit(inboundEvent("again"));

		expect(channel.sends.map((m) => m.text)).toEqual([
			"hello from fake ACP",
			"pending push",
			"hello from fake ACP",
		]);
	} finally {
		await gateway.stop();
	}
});

test("allowTrusted does not carry a past turn's trust to a permission between turns", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient();
	const gateway = chatGateway(channel, fakeClient, {
		permissions: { inbound: { mode: "open" }, toolCalls: "allowTrusted" },
	});

	await gateway.start();
	try {
		await channel.emit(
			createTextInboundEvent({
				text: "hi",
				conversationId: "c1",
				senderId: "u1",
				trusted: true,
			}),
		);

		expect(
			await fakeClient.requestPermission({
				sessionId: "fake-session-1",
				options: PERMISSION_OPTIONS,
			}),
		).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
	} finally {
		await gateway.stop();
	}
});

test("/cancel cancels the turn and answers its pending permission `cancelled`", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({
		permissionOptions: PERMISSION_OPTIONS,
	});
	const gateway = chatGateway(channel, fakeClient, {
		intake: { mode: "ackFast" },
		permissions: { inbound: { mode: "open" }, toolCalls: "ask" },
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go"));
		await waitFor(() => channel.sends.find((m) => m.interaction));
		await channel.emit(inboundEvent("/cancel"));
		await gateway.drain();

		expect(fakeClient.cancelCalls).toEqual(["fake-session-1"]);
		expect(fakeClient.permissionOutcome).toEqual({
			outcome: { outcome: "cancelled" },
		});
		expect(channel.sends.map((m) => m.text)).toContain(
			"Cancelled the current turn.",
		);
		// The command never reached the agent as a prompt.
		expect(fakeClient.prompts).toHaveLength(1);
	} finally {
		await gateway.stop();
	}
});

test("parses reserved commands exactly", () => {
	expect(parseReservedCommand("/cancel")).toEqual({ name: "cancel" });
	expect(parseReservedCommand("  /new \n")).toEqual({ name: "new" });
	expect(parseReservedCommand("/mode trusted")).toEqual({
		name: "mode",
		modeId: "trusted",
	});
	expect(parseReservedCommand("/mode")).toEqual({ name: "mode" });
	expect(parseReservedCommand("/mode a b")).toBeUndefined();
	expect(parseReservedCommand("/cancel now")).toBeUndefined();
	expect(parseReservedCommand("please /new")).toBeUndefined();
	expect(parseReservedCommand(undefined)).toBeUndefined();
});

test("passes MCP servers to session/new in ACP's shape", async () => {
	expect(
		resolveMcpServers(
			[
				{
					name: "files",
					command: "mcp-files",
					args: ["--root", "/"],
					env: { TOKEN: "t" },
				},
				{
					name: "web",
					type: "http",
					url: "https://mcp.example",
					headers: [{ name: "Authorization", value: "Bearer x" }],
				},
			],
			{ command: "agent" },
		),
	).toEqual([
		{
			name: "files",
			command: "mcp-files",
			args: ["--root", "/"],
			env: [{ name: "TOKEN", value: "t" }],
		},
		{
			type: "http",
			name: "web",
			url: "https://mcp.example",
			headers: [{ name: "Authorization", value: "Bearer x" }],
		},
	]);

	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient();
	const config = normalizeConfig({
		agents: { default: { command: "fake-agent", mcpServers: ["files"] } },
		mcpServers: [
			{ name: "files", command: "mcp-files", env: { A: "1" } },
			{ name: "other", command: "mcp-other" },
		],
		channels: {
			test: { type: "test", permissions: { inbound: { mode: "open" } } },
		},
		state: { driver: "memory" },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { test: channel.factory },
		acpClientFactory: () => fakeClient,
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));
		expect(fakeClient.newSessionRequests[0]?.mcpServers).toEqual([
			{
				name: "files",
				command: "mcp-files",
				args: [],
				env: [{ name: "A", value: "1" }],
			},
		]);
	} finally {
		await gateway.stop();
	}
});

test("a channel that fails to start is reported, and the others still serve", async () => {
	const broken = createRecordingChannel([], { failStart: true });
	const working = createRecordingChannel([
		{ ok: false, error: "rate limited" },
	]);
	const fakeClient = new FakeAcpClient();
	const gateway = chatGateway(broken, fakeClient, {}, { working });

	await gateway.start();
	try {
		let status = await gateway.status();
		expect(status.ok).toBe(false);
		expect(status.channels.test).toMatchObject({
			type: "test",
			state: "failing",
			lastError: "bad token",
		});
		expect(status.channels.working?.state).toBe("ready");
		expect(status.agents.default?.state).toBe("idle");

		// A send that gives up marks the channel failing until one succeeds.
		await working.emit(inboundEvent("hi"));
		status = await gateway.status();
		expect(status.channels.working).toMatchObject({
			state: "failing",
			lastError: "rate limited",
		});
		expect(status.agents.default?.state).toBe("up");

		await working.emit(inboundEvent("again"));
		expect((await gateway.status()).channels.working?.state).toBe("ready");
	} finally {
		await gateway.stop();
	}
});

test("respawns an agent that exits and rehydrates its sessions", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({ supportsLoad: true });
	const gateway = chatGateway(channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));
		expect(fakeClient.connects).toBe(1);

		fakeClient.exit();
		expect((await gateway.status()).agents.default?.state).toBe("down");

		// First respawn after 1s of backoff; then the session is loaded again.
		await waitFor(
			() => (fakeClient.loadCalls.length > 0 ? true : undefined),
			3000,
		);
		await gateway.drain();
		expect(fakeClient.connects).toBe(2);
		expect(fakeClient.loadCalls).toEqual(["fake-session-1"]);
		expect(fakeClient.sessionsCreated).toBe(1);

		// And a push reaches the conversation again.
		await fakeClient.emitUpdate(
			"fake-session-1",
			textChunk("back", { "acpantenna/push": { final: true } }),
		);
		await gateway.drain();
		expect(channel.sends.at(-1)?.text).toBe("back");
	} finally {
		await gateway.stop();
	}
});

test("rehydration only covers sessions used within the window", () => {
	const now = Date.parse("2026-10-04T00:00:00Z");

	expect(isWithinDays("2026-09-28T00:00:00Z", 7, now)).toBe(true);
	expect(isWithinDays("2026-09-26T00:00:00Z", 7, now)).toBe(false);
	expect(isWithinDays("not a date", 7, now)).toBe(false);
});

const CHOICE_ELICITATION = {
	mode: "form",
	message: "A question from session fix-login",
	requestedSchema: {
		type: "object",
		properties: {
			answer: {
				type: "string",
				title: "Answer",
				description: "Ship it?",
				enum: ["yes", "no"],
			},
		},
		required: ["answer"],
	},
};

test("elicitation fields keep title, description and enum, spelled out in the text fallback", async () => {
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient({ elicitation: CHOICE_ELICITATION });
	const gateway = chatGateway(channel, fakeClient, {
		intake: { mode: "ackFast" },
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go"));

		const prompt = await waitFor(() =>
			channel.sends.find((message) => message.interaction),
		);
		expect(prompt.interaction?.fields).toEqual([
			{
				name: "answer",
				type: "string",
				required: true,
				title: "Answer",
				description: "Ship it?",
				enum: ["yes", "no"],
			},
		]);
		expect(prompt.text).toContain("answer* (one of: yes, no) — Ship it?");
		// No buttons: no options to click.
		expect(prompt.interaction?.options).toBeUndefined();

		const response = inboundEvent("");
		response.interaction = {
			id: prompt.interaction?.id ?? "",
			content: { answer: "yes" },
		};
		await channel.emit(response);
		await gateway.drain();

		expect(fakeClient.elicitationOutcome).toEqual({
			action: "accept",
			content: { answer: "yes" },
		});
	} finally {
		await gateway.stop();
	}
});

test("a single required enum field is offered as options to a channel with buttons", async () => {
	const channel = createRecordingChannel([], {
		capabilities: { buttons: true },
	});
	const fakeClient = new FakeAcpClient({
		elicitation: {
			mode: "form",
			message: "Deploy where?",
			requestedSchema: {
				type: "object",
				properties: {
					target: {
						type: "string",
						oneOf: [
							{ const: "prod", title: "Production" },
							{ const: "staging", title: "Staging" },
						],
					},
				},
				required: ["target"],
			},
		},
	});
	const gateway = chatGateway(channel, fakeClient, {
		intake: { mode: "ackFast" },
	});

	await gateway.start();
	try {
		await channel.emit(inboundEvent("go"));

		const prompt = await waitFor(() =>
			channel.sends.find((message) => message.interaction),
		);
		expect(prompt.text).toBe("📝 Deploy where?");
		expect(prompt.interaction?.fields?.[0]).toMatchObject({
			enum: ["prod", "staging"],
			enumTitles: ["Production", "Staging"],
		});
		expect(prompt.interaction?.options).toEqual([
			{ id: "prod", label: "Production", kind: "choice" },
			{ id: "staging", label: "Staging", kind: "choice" },
		]);

		const response = inboundEvent("");
		response.interaction = {
			id: prompt.interaction?.id ?? "",
			optionId: "staging",
		};
		await channel.emit(response);
		await gateway.drain();

		expect(fakeClient.elicitationOutcome).toEqual({
			action: "accept",
			content: { target: "staging" },
		});
	} finally {
		await gateway.stop();
	}
});

test("each channel gets a state directory of its own beside the state store", () => {
	expect(channelStateDir("/srv/state/acpantenna.sqlite", "matrix")).toBe(
		join("/srv/state", "channels", "matrix"),
	);
	// A config key is not trusted as a path.
	expect(channelStateDir("/srv/state/a.sqlite", "../etc")).toBe(
		join("/srv/state", "channels", ".._etc"),
	);
	expect(channelStateDir("/srv/state/a.sqlite", "..")).toBe(
		join("/srv/state", "channels", "_"),
	);
});

// ------------------------------------------------------------- attachments

function fileChunk(path: string, meta?: Record<string, unknown>) {
	return {
		sessionUpdate: "agent_message_chunk",
		content: {
			type: "resource_link",
			uri: pathToFileURL(path).href,
			name: basename(path),
		},
		...(meta ? { _meta: meta } : {}),
	};
}

function scratchFile(
	name: string,
	bytes: number,
): { path: string; done: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "acpantenna-attach-"));
	const path = join(dir, name);
	writeFileSync(path, new Uint8Array(bytes));
	return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a pushed file reaches a channel that carries files, measured and typed", async () => {
	const file = scratchFile("screen.png", 2048);
	const channel = createRecordingChannel([], {
		capabilities: { attachments: true },
	});
	const fakeClient = new FakeAcpClient();
	const gateway = chatGateway(channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));
		await fakeClient.emitUpdate(
			"fake-session-1",
			fileChunk(file.path, { "acpantenna/push": { final: true } }),
		);
		await gateway.drain();

		expect(channel.sends[1]).toMatchObject({
			origin: "push",
			attachment: {
				name: "screen.png",
				mimeType: "image/png",
				size: 2048,
				kind: "image",
				path: file.path,
			},
		});
	} finally {
		await gateway.stop();
		file.done();
	}
});

test("a channel that cannot carry files is told about one in text", async () => {
	const file = scratchFile("report.pdf", 1500);
	const channel = createRecordingChannel();
	const fakeClient = new FakeAcpClient();
	const gateway = chatGateway(channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));
		await fakeClient.emitUpdate("fake-session-1", fileChunk(file.path));
		await gateway.drain();

		expect(channel.sends[1]?.attachment).toBeUndefined();
		expect(channel.sends[1]?.text).toBe(
			`📎 report.pdf (1.5 KB): this channel cannot receive files. It is at ${file.path} on the agent's computer.`,
		);
	} finally {
		await gateway.stop();
		file.done();
	}
});

test("a file that is gone by the time it is sent is reported, not dropped", async () => {
	const channel = createRecordingChannel([], {
		capabilities: { attachments: true },
	});
	const fakeClient = new FakeAcpClient();
	const gateway = chatGateway(channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));
		await fakeClient.emitUpdate(
			"fake-session-1",
			fileChunk("/nonexistent/shot.png"),
		);
		await gateway.drain();

		expect(channel.sends[1]?.text).toBe(
			`⚠️ Could not send shot.png (0 B): ${resolve("/nonexistent/shot.png")} is not there any more.`,
		);
	} finally {
		await gateway.stop();
	}
});

test("a file sent mid-turn follows a buffered reply", async () => {
	const file = scratchFile("chart.png", 10);
	const channel = createRecordingChannel([], {
		capabilities: { attachments: true },
	});
	const fakeClient = new FakeAcpClient({
		updatesDuringTurn: [fileChunk(file.path)],
	});
	const gateway = chatGateway(channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));

		expect(
			channel.sends.map((m) => [m.text ?? m.attachment?.name, m.origin]),
		).toEqual([
			["hello from fake ACP", "turn"],
			["chart.png", "turn"],
		]);
	} finally {
		await gateway.stop();
		file.done();
	}
});

test("a file the channel refuses is followed by why, in the conversation", async () => {
	const file = scratchFile("big.bin", 10);
	const channel = createRecordingChannel(
		[{ ok: true }, { ok: false, error: "the server said no." }],
		{ capabilities: { attachments: true } },
	);
	const fakeClient = new FakeAcpClient();
	const gateway = chatGateway(channel, fakeClient);

	await gateway.start();
	try {
		await channel.emit(inboundEvent("hi"));
		await fakeClient.emitUpdate("fake-session-1", fileChunk(file.path));
		await gateway.drain();

		expect(channel.sends[2]?.text).toBe(
			"⚠️ Could not send big.bin (10 B): the server said no.",
		);
	} finally {
		await gateway.stop();
		file.done();
	}
});
