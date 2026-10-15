import { describe, expect, test } from "bun:test";
import type { ChannelAcpConnection } from "@acpantenna/channel";
import {
	AcpProxy,
	checkElicitationAnswer,
	checkPermissionAnswer,
	filteredInitialize,
} from "./proxy.ts";

interface Fake {
	proxy: AcpProxy;
	sent: Array<Record<string, unknown>>;
	calls: Array<{ method: string; params: unknown }>;
	connection: ChannelAcpConnection;
}

function fake(options: { coalesceMs?: number; timeoutMs?: number } = {}): Fake {
	const sent: Array<Record<string, unknown>> = [];
	const calls: Array<{ method: string; params: unknown }> = [];
	let sessionId = "s1";
	const connection: ChannelAcpConnection = {
		channelId: "web",
		conversationId: "c1",
		agentId: "dumb",
		cwd: "/work",
		get acpSessionId() {
			return sessionId;
		},
		initializeResult: {
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true },
				mcpCapabilities: { http: true, sse: true },
				sessionCapabilities: { resume: {}, fork: {}, close: {}, list: {} },
				_meta: { secret: true },
			},
			authMethods: [{ id: "key", name: "Key" }],
			agentInfo: { name: "agent", version: "1" },
		},
		mcpServers: [{ name: "configured", command: "x", args: [], env: [] }],
		request: async (method, params) => {
			calls.push({ method, params });
			if (method === "session/prompt") {
				return { stopReason: "end_turn" };
			}
			if (method === "session/set_mode") {
				throw { code: -32602, message: "unknown mode", data: { modeId: "x" } };
			}
			return {};
		},
		notify: async (method, params) => {
			calls.push({ method, params });
		},
		newSession: async () => {
			sessionId = "s2";
			return { sessionId };
		},
		end: async () => undefined,
	};
	const proxy = new AcpProxy({
		connection,
		send: (message) => sent.push(JSON.parse(message)),
		coalesceMs: options.coalesceMs ?? 10,
		interactionTimeoutMs: options.timeoutMs ?? 1000,
	});

	return { proxy, sent, calls, connection };
}

const request = (id: unknown, method: string, params: unknown = {}) =>
	JSON.stringify({ jsonrpc: "2.0", id, method, params });

const chunk = (
	text: string,
	kind = "agent_message_chunk",
	sessionId = "s1",
) => ({
	sessionId,
	update: { sessionUpdate: kind, content: { type: "text", text } },
});

describe("browser to agent", () => {
	test("initialize keeps only what the proxy lets through", () => {
		expect(filteredInitialize(fake().connection.initializeResult)).toEqual({
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true },
				mcpCapabilities: { http: false, sse: false },
				sessionCapabilities: { list: {}, resume: {} },
			},
			authMethods: [],
			agentInfo: { name: "agent", version: "1" },
		});
	});

	test("an unknown method is not found, and never reaches the agent", async () => {
		const { proxy, sent, calls } = fake();

		await proxy.receive(request(7, "terminal/create", { command: "sh" }));
		expect(sent).toEqual([
			{
				jsonrpc: "2.0",
				id: 7,
				error: { code: -32601, message: "Method not found: terminal/create" },
			},
		]);
		expect(calls).toEqual([]);
	});

	test("load pins the directory and MCP servers", async () => {
		const { proxy, calls } = fake();

		await proxy.receive(
			request(1, "session/load", {
				sessionId: "s1",
				cwd: "/",
				mcpServers: [{ name: "evil", command: "rm" }],
				extra: true,
			}),
		);
		expect(calls).toEqual([
			{
				method: "session/load",
				params: {
					sessionId: "s1",
					cwd: "/work",
					mcpServers: [{ name: "configured", command: "x", args: [], env: [] }],
				},
			},
		]);
	});

	test("the agent's errors reach the browser as they were", async () => {
		const { proxy, sent } = fake();

		await proxy.receive(
			request("m", "session/set_mode", { sessionId: "s1", modeId: "x" }),
		);
		expect(sent).toEqual([
			{
				jsonrpc: "2.0",
				id: "m",
				error: { code: -32602, message: "unknown mode", data: { modeId: "x" } },
			},
		]);
	});

	test("cancel passes for this session only", async () => {
		const { proxy, calls } = fake();

		await proxy.receive(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "session/cancel",
				params: { sessionId: "other" },
			}),
		);
		await proxy.receive(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "session/cancel",
				params: { sessionId: "s1" },
			}),
		);
		expect(calls).toEqual([
			{ method: "session/cancel", params: { sessionId: "s1" } },
		]);
	});

	test("malformed messages get JSON-RPC errors", async () => {
		const { proxy, sent } = fake();

		await proxy.receive("{not json");
		await proxy.receive(JSON.stringify({ id: 1, method: "initialize" }));
		expect(
			sent.map((message) => (message.error as { code: number }).code),
		).toEqual([-32700, -32600]);
	});
});

describe("agent to browser", () => {
	test("text chunks are batched on the tick, in order with everything else", async () => {
		const { proxy, sent } = fake({ coalesceMs: 30 });

		proxy.notification("session/update", chunk("Hel"));
		proxy.notification("session/update", chunk("lo"));
		proxy.notification("session/update", chunk("hmm", "agent_thought_chunk"));
		proxy.notification("session/update", chunk(" there"));
		proxy.notification("session/update", chunk("!"));
		proxy.notification("session/update", {
			sessionId: "s1",
			update: { sessionUpdate: "tool_call", toolCallId: "t", title: "x" },
		});
		proxy.notification("session/update", chunk("after"));
		expect(sent).toHaveLength(4);
		await Bun.sleep(60);

		expect(
			sent.map((message) => {
				const update = (message.params as { update: Record<string, unknown> })
					.update;
				const content = update.content as { text?: string } | undefined;
				return `${update.sessionUpdate}:${content?.text ?? ""}`;
			}),
		).toEqual([
			"agent_message_chunk:Hello",
			"agent_thought_chunk:hmm",
			"agent_message_chunk: there!",
			"tool_call:",
			"agent_message_chunk:after",
		]);
	});

	test("a chunk with metadata is not merged", async () => {
		const { proxy, sent } = fake({ coalesceMs: 5 });
		const withMeta = chunk("b");

		(withMeta.update as Record<string, unknown>)._meta = { final: true };
		proxy.notification("session/update", chunk("a"));
		proxy.notification("session/update", withMeta);
		await Bun.sleep(20);
		expect(sent).toHaveLength(2);
	});

	test("a permission answer is checked, and allow-always becomes allow-once", async () => {
		const { proxy, sent } = fake();
		const params = {
			sessionId: "s1",
			options: [
				{ optionId: "once", kind: "allow_once", name: "Once" },
				{ optionId: "always", kind: "allow_always", name: "Always" },
				{ optionId: "no", kind: "reject_once", name: "No" },
			],
		};
		const answer = proxy.request("session/request_permission", params);

		await Bun.sleep(0);
		const asked = sent[0] as { id: number; method: string };
		expect(asked.method).toBe("session/request_permission");
		// The proxy's own id, not the agent's.
		expect(typeof asked.id).toBe("number");

		await proxy.receive(
			JSON.stringify({
				jsonrpc: "2.0",
				id: asked.id,
				result: { outcome: { outcome: "selected", optionId: "always" } },
			}),
		);
		expect(await answer).toEqual({
			outcome: { outcome: "selected", optionId: "once" },
		});
	});

	test("an option the agent did not offer, an error or no answer refuses", async () => {
		const params = {
			options: [
				{ optionId: "ok", kind: "allow_once" },
				{ optionId: "no", kind: "reject_once" },
			],
		};
		const rejected = { outcome: { outcome: "selected", optionId: "no" } };

		expect(
			checkPermissionAnswer(params, {
				outcome: { outcome: "selected", optionId: "made-up" },
			}),
		).toEqual(rejected);
		expect(checkPermissionAnswer(params, undefined)).toEqual(rejected);
		expect(
			checkPermissionAnswer(
				{ options: [{ optionId: "a", kind: "allow_always" }] },
				{
					outcome: { outcome: "selected", optionId: "a" },
				},
			),
		).toEqual({ outcome: { outcome: "cancelled" } });

		const { proxy } = fake({ timeoutMs: 20 });
		expect(await proxy.request("session/request_permission", params)).toEqual(
			rejected,
		);
	});

	test("elicitation answers are checked", () => {
		expect(
			checkElicitationAnswer({}, { action: "accept", content: { a: 1 } }),
		).toEqual({
			action: "accept",
			content: { a: 1 },
		});
		expect(checkElicitationAnswer({}, { action: "accept" })).toEqual({
			action: "decline",
		});
		expect(checkElicitationAnswer({}, "nonsense")).toEqual({
			action: "decline",
		});
		expect(checkElicitationAnswer({}, { action: "cancel" })).toEqual({
			action: "cancel",
		});
	});

	test("other agent requests are refused", async () => {
		const { proxy, sent } = fake();

		await expect(
			proxy.request("fs/read_text_file", { path: "/etc/passwd" }),
		).rejects.toMatchObject({
			code: -32601,
		});
		expect(sent).toEqual([]);
	});

	test("closing cancels a turn the browser started", async () => {
		const { proxy, calls, connection } = fake();
		let finish: (value: unknown) => void = () => undefined;

		connection.request = async (method, params) => {
			calls.push({ method, params });
			return await new Promise((resolve) => {
				finish = resolve;
			});
		};
		const turn = proxy.receive(
			request(1, "session/prompt", { sessionId: "s1", prompt: [] }),
		);

		await Bun.sleep(0);
		proxy.close();
		await Bun.sleep(0);
		expect(calls.map((call) => call.method)).toEqual([
			"session/prompt",
			"session/cancel",
		]);
		finish({ stopReason: "cancelled" });
		await turn;
	});

	test("closing answers pending questions", async () => {
		const { proxy } = fake();
		const answer = proxy.request("elicitation/create", { sessionId: "s1" });

		proxy.close();
		expect(await answer).toEqual({ action: "decline" });
	});
});
