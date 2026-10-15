import { describe, expect, test } from "bun:test";
import { editContent, LiveMessage } from "./live-message.ts";
import { RoomOutbox, replyContent } from "./outbox.ts";
import {
	createFakeClock,
	createRecordingTransport,
} from "./testing/fake-clock.ts";

function setup(
	options: { firstSendDelayMs?: number; editIntervalMs?: number } = {},
) {
	const clock = createFakeClock();
	const { calls, transport } = createRecordingTransport(clock.now);
	const outbox = new RoomOutbox({
		transport,
		firstSendDelayMs: options.firstSendDelayMs ?? 400,
		editIntervalMs: options.editIntervalMs ?? 3000,
		schedule: clock.schedule,
		now: clock.now,
	});

	return { clock, calls, outbox };
}

describe("streamed replies", () => {
	test("a burst of chunks becomes one message", async () => {
		const { clock, calls, outbox } = setup();

		outbox.appendReply("Hel", "msg-1");
		outbox.appendReply("lo, ");
		outbox.appendReply("world");
		await clock.advance(400);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			op: "send",
			txnId: "msg-1",
			content: { msgtype: "m.text", body: "Hello, world" },
		});
	});

	test("later chunks are folded into edits at most once per interval", async () => {
		const { clock, calls, outbox } = setup();
		const words = ["one", " two", " three", " four", " five", " six", " seven"];

		for (const word of words) {
			outbox.appendReply(word);
			await clock.advance(1000);
		}

		await clock.advance(3000);

		const edits = calls.filter((call) => call.op === "edit");
		expect(calls[0]).toMatchObject({ op: "send", at: 400 });
		expect(edits.length).toBeLessThan(words.length - 1);
		expect(edits.every((edit) => edit.eventId === "$event1")).toBe(true);

		for (let index = 1; index < calls.length; index += 1) {
			expect(calls[index]!.at - calls[index - 1]!.at).toBeGreaterThanOrEqual(
				3000,
			);
		}

		expect(calls.at(-1)?.content.body).toBe(words.join(""));
	});

	test("ending the turn sends what is pending at once, and the next reply is a new message", async () => {
		const { clock, calls, outbox } = setup();

		outbox.appendReply("first answer");
		await clock.advance(400);
		outbox.appendReply(", finished");
		await outbox.endTurn();

		expect(calls.map((call) => [call.op, call.content.body])).toEqual([
			["send", "first answer"],
			["edit", "first answer, finished"],
		]);

		outbox.appendReply("second answer");
		await clock.advance(400);

		expect(calls.at(-1)).toMatchObject({ op: "send", eventId: "$event2" });
	});

	test("a reply too long for one event continues in another", async () => {
		const { clock, calls, outbox } = setup();
		const paragraph = `${"x".repeat(9_000)}\n\n`;

		outbox.appendReply(`${paragraph}${paragraph}tail`);
		await clock.advance(400);

		expect(calls.map((call) => call.op)).toEqual(["send", "send"]);
		expect(calls[0]?.content.body.length).toBeLessThanOrEqual(16_000);
		expect(calls[1]?.content.body.endsWith("tail")).toBe(true);
	});
});

describe("tool calls", () => {
	test("a turn's tool calls share one notice, edited as their status changes", async () => {
		const { clock, calls, outbox } = setup();

		outbox.toolCall({
			id: "a",
			title: "Read `a.ts`",
			kind: "read",
			status: "pending",
		});
		outbox.toolCall({
			id: "b",
			title: "Run tests",
			kind: "execute",
			status: "in_progress",
		});
		await clock.advance(400);
		outbox.toolCall({ id: "a", status: "completed" });
		outbox.toolCall({ id: "b", status: "failed" });
		await clock.advance(3000);

		expect(calls.map((call) => call.op)).toEqual(["send", "edit"]);
		expect(calls[0]?.content).toMatchObject({
			msgtype: "m.notice",
			body: "⏳ 📖 Read `a.ts`\n⏳ 💻 Run tests",
		});
		expect(calls[0]?.content.formatted_body).toContain("<code>a.ts</code>");
		expect(calls[1]?.content.body).toBe("✅ 📖 Read `a.ts`\n❌ 💻 Run tests");
	});

	test("text and tool calls stay in the order they happened", async () => {
		const { clock, calls, outbox } = setup();

		outbox.appendReply("Let me look.");
		outbox.toolCall({
			id: "a",
			title: "Search",
			kind: "search",
			status: "pending",
		});
		outbox.appendReply("Found it.");
		await clock.advance(400);
		// A late status change edits the earlier notice, not a new one.
		outbox.toolCall({ id: "a", status: "completed" });
		await clock.advance(3000);

		expect(
			calls.map((call) => [call.op, call.eventId, call.content.body]),
		).toEqual([
			["send", "$event1", "Let me look."],
			["send", "$event2", "⏳ 🔍 Search"],
			["send", "$event3", "Found it."],
			["edit", "$event2", "✅ 🔍 Search"],
		]);
	});

	test("a message of its own closes the open one first", async () => {
		const { clock, calls, outbox } = setup();

		outbox.appendReply("streaming");
		const eventId = await outbox.send(replyContent("a push"));
		await clock.advance(5000);

		expect(eventId).toBe("$event2");
		expect(calls.map((call) => call.content.body)).toEqual([
			"streaming",
			"a push",
		]);
	});
});

describe("LiveMessage", () => {
	test("gives up on content that keeps failing, instead of retrying forever", async () => {
		const clock = createFakeClock();
		let attempts = 0;
		const errors: unknown[] = [];
		const live = new LiveMessage({
			transport: {
				async send() {
					attempts += 1;
					throw new Error("forbidden");
				},
				async edit() {},
			},
			run: (task) => task(),
			firstSendDelayMs: 100,
			editIntervalMs: 1000,
			schedule: clock.schedule,
			now: clock.now,
			onError: (error) => errors.push(error),
		});

		live.set(replyContent("hello"));
		await clock.advance(10_000);

		expect(attempts).toBe(3);
		expect(errors).toHaveLength(3);
	});

	test("an edit is an m.replace with the new content and a starred fallback", () => {
		expect(
			editContent("$original", {
				msgtype: "m.text",
				body: "new",
				format: "org.matrix.custom.html",
				formatted_body: "<b>new</b>",
			}),
		).toEqual({
			msgtype: "m.text",
			body: "* new",
			format: "org.matrix.custom.html",
			formatted_body: "* <b>new</b>",
			"m.new_content": {
				msgtype: "m.text",
				body: "new",
				format: "org.matrix.custom.html",
				formatted_body: "<b>new</b>",
			},
			"m.relates_to": { rel_type: "m.replace", event_id: "$original" },
		});
	});
});
