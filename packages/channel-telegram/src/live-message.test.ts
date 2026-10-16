import { describe, expect, test } from "bun:test";
import { ChatOutbox } from "./outbox.ts";
import {
	createFakeClock,
	createRecordingTransport,
} from "./testing/fake-clock.ts";

function setup(options: { editIntervalMs?: number; maxChars?: number } = {}) {
	const clock = createFakeClock();
	const { calls, transport } = createRecordingTransport(clock.now);
	const outbox = new ChatOutbox({
		transport,
		firstSendDelayMs: 400,
		editIntervalMs: options.editIntervalMs ?? 1000,
		maxChars: options.maxChars,
		schedule: clock.schedule,
		now: clock.now,
	});

	return { clock, calls, outbox };
}

describe("streamed replies", () => {
	test("a burst of chunks becomes one message, as HTML", async () => {
		const { clock, calls, outbox } = setup();

		outbox.appendReply("Hel");
		outbox.appendReply("lo, **");
		outbox.appendReply("world**");
		await clock.advance(400);

		expect(calls).toEqual([
			{
				op: "send",
				messageId: 1,
				at: 400,
				content: { html: "Hello, <b>world</b>", text: "Hello, **world**" },
			},
		]);
	});

	test("later chunks are folded into edits at most once per interval", async () => {
		const { clock, calls, outbox } = setup({ editIntervalMs: 1000 });
		const words = ["one", " two", " three", " four", " five", " six"];

		for (const word of words) {
			outbox.appendReply(word);
			await clock.advance(300);
		}

		await clock.advance(1000);

		const edits = calls.filter((call) => call.op === "edit");
		expect(edits.length).toBeLessThan(words.length - 1);
		expect(edits.every((edit) => edit.messageId === 1)).toBe(true);

		for (let index = 1; index < calls.length; index += 1) {
			expect(calls[index]!.at - calls[index - 1]!.at).toBeGreaterThanOrEqual(
				1000,
			);
		}

		expect(calls.at(-1)?.content.text).toBe(words.join(""));
	});

	test("ending the turn sends what is pending, and the next reply is a new message", async () => {
		const { clock, calls, outbox } = setup();

		outbox.appendReply("first answer");
		await clock.advance(400);
		outbox.appendReply(", finished");
		await outbox.endTurn();

		expect(calls.map((call) => [call.op, call.content.text])).toEqual([
			["send", "first answer"],
			["edit", "first answer, finished"],
		]);

		outbox.appendReply("second answer");
		await clock.advance(400);

		expect(calls.at(-1)).toMatchObject({ op: "send", messageId: 2 });
	});

	test("a reply past the limit continues in a new message", async () => {
		const { clock, calls, outbox } = setup({ maxChars: 200 });
		const paragraph = `${"x".repeat(150)}\n\n`;

		outbox.appendReply(`${paragraph}${paragraph}tail`);
		await outbox.endTurn();
		await clock.advance(400);

		const sends = calls.filter((call) => call.op === "send");
		expect(sends.length).toBe(2);
		expect(sends.every((call) => call.content.text.length <= 200)).toBe(true);
		expect(sends.at(-1)?.content.text.endsWith("tail")).toBe(true);
	});
});

describe("tool calls", () => {
	test("a turn's tool calls are one log, edited as they finish", async () => {
		const { clock, calls, outbox } = setup();

		outbox.toolCall({
			id: "t1",
			title: "Run `bun test`",
			kind: "execute",
			status: "pending",
		});
		outbox.toolCall({ id: "t2", title: "Read README", kind: "read" });
		await clock.advance(400);
		outbox.toolCall({ id: "t1", status: "completed" });
		await clock.advance(1000);

		expect(calls.map((call) => [call.op, call.content.text])).toEqual([
			["send", "⏳ 💻 Run `bun test`\n⏳ 📖 Read README"],
			["edit", "✅ 💻 Run `bun test`\n⏳ 📖 Read README"],
		]);
		expect(calls[1]?.content.html).toBe(
			"✅ 💻 Run <code>bun test</code>\n⏳ 📖 Read README",
		);
	});

	test("a reply after the tools is a message of its own, below them", async () => {
		const { clock, calls, outbox } = setup();

		outbox.toolCall({ id: "t1", title: "Search", kind: "search" });
		outbox.appendReply("Found it.");
		await clock.advance(400);

		expect(calls.map((call) => [call.op, call.messageId])).toEqual([
			["send", 1],
			["send", 2],
		]);
	});
});
