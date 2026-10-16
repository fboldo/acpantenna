import { expect, test } from "bun:test";
import type { LiveMessageTransport, MessageContent } from "./live-message.ts";
import { ChannelOutbox } from "./outbox.ts";
import { renderToolCalls, toolCallLine } from "./tool-calls.ts";

function setup() {
	const log: string[] = [];
	const messages = new Map<string, MessageContent>();
	let next = 0;
	let now = 0;
	const timers: Array<{ callback: () => void; at: number; live: boolean }> = [];
	const transport: LiveMessageTransport = {
		send: async (content) => {
			const id = `m${++next}`;
			messages.set(id, content);
			log.push(`send ${id}`);
			return id;
		},
		edit: async (id, content) => {
			messages.set(id, content);
			log.push(`edit ${id}`);
		},
	};
	const outbox = new ChannelOutbox({
		transport,
		firstSendDelayMs: 400,
		editIntervalMs: 1500,
		now: () => now,
		schedule: (callback, ms) => {
			const timer = { callback, at: now + ms, live: true };
			timers.push(timer);
			return () => {
				timer.live = false;
			};
		},
	});

	/** Move the clock on, running what falls due. */
	const advance = async (ms: number) => {
		now += ms;

		for (const timer of timers.filter((t) => t.live && t.at <= now)) {
			timer.live = false;
			timer.callback();
		}

		await outbox.idle();
	};

	return { outbox, log, messages, advance };
}

test("a streamed reply is one message, edited at most every interval", async () => {
	const { outbox, log, messages, advance } = setup();

	outbox.appendReply("Hel");
	outbox.appendReply("lo");
	await advance(400);
	expect(log).toEqual(["send m1"]);
	expect(messages.get("m1")?.content).toBe("Hello");

	outbox.appendReply(", wor");
	await advance(500);
	outbox.appendReply("ld");
	await advance(500);
	expect(log).toEqual(["send m1"]);
	await advance(500);
	expect(log).toEqual(["send m1", "edit m1"]);
	expect(messages.get("m1")?.content).toBe("Hello, world");
});

test("a reply past 2000 characters goes on in a new message", async () => {
	const { outbox, messages, advance } = setup();
	const paragraph = "word ".repeat(100).trim();

	for (let i = 0; i < 6; i += 1) {
		outbox.appendReply(`${paragraph}\n\n`);
	}

	await outbox.endTurn();
	await advance(0);
	const parts = [...messages.values()].map((entry) => entry.content);

	expect(parts.length).toBe(2);
	for (const part of parts) {
		expect(part.length).toBeLessThanOrEqual(2000);
	}
	expect(parts.join("\n\n").replace(/\s+$/, "")).toBe(
		Array.from({ length: 6 }, () => paragraph).join("\n\n"),
	);
});

test("tool calls are one quiet log, updated in place", async () => {
	const { outbox, log, messages, advance } = setup();

	outbox.toolCall({ id: "t1", title: "Run tests", kind: "execute" });
	outbox.toolCall({ id: "t2", title: "Read `a.ts`", kind: "read" });
	await advance(400);
	expect(messages.get("m1")).toEqual({
		content: "-# ⏳ 💻 Run tests\n-# ⏳ 📖 Read `a.ts`",
		quiet: true,
	});

	outbox.toolCall({ id: "t1", status: "completed" });
	await advance(1500);
	expect(log).toEqual(["send m1", "edit m1"]);
	expect(messages.get("m1")?.content).toBe(
		"-# ✅ 💻 Run tests\n-# ⏳ 📖 Read `a.ts`",
	);

	// A reply after the log is a message of its own, below it.
	outbox.appendReply("Done.");
	outbox.toolCall({ id: "t2", status: "failed" });
	await outbox.endTurn();
	await advance(1500);
	expect(messages.get("m2")?.content).toBe("Done.");
	expect(messages.get("m1")?.content).toContain("❌ 📖");
});

test("a long log starts a new message before it passes the limit", async () => {
	const { outbox, messages } = setup();

	for (let i = 0; i < 30; i += 1) {
		outbox.toolCall({ id: `t${i}`, title: "x".repeat(150), kind: "edit" });
	}

	await outbox.endTurn();
	for (const message of messages.values()) {
		expect(message.content.length).toBeLessThanOrEqual(2000);
	}
	expect(messages.size).toBeGreaterThan(1);
});

test("a tool call line is compact, with a fallback title", () => {
	expect(toolCallLine({ id: "x", status: "in_progress" })).toBe(
		"-# ⏳ 🔧 Tool call",
	);
	expect(
		renderToolCalls([
			{ id: "x", kind: "fetch", title: "GET", status: "completed" },
		]),
	).toBe("-# ✅ 🌐 GET");
});
