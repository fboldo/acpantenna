import { describe, expect, test } from "bun:test";
import { ConversationOutbox } from "./outbox.ts";
import { createFakeClock } from "./testing/fake-clock.ts";

function setup(options: { maxLines?: number; budget?: number } = {}) {
	const clock = createFakeClock();
	const sent: string[] = [];
	const outbox = new ConversationOutbox({
		target: "#chan",
		transport: {
			privmsg: (_, text) => sent.push(text),
			notice: (_, text) => sent.push(`notice: ${text}`),
			budget: () => options.budget ?? 400,
		},
		maxLines: options.maxLines ?? 3,
		moreCommand: () => "bot: more",
		schedule: clock.schedule,
	});

	return { clock, sent, outbox };
}

describe("long replies", () => {
	test("send the first lines, then the rest on “more”", () => {
		const { sent, outbox } = setup();

		outbox.reply("1\n2\n3\n4\n5\n6\n7");
		expect(sent).toEqual([
			"1",
			"2",
			"3",
			"notice: … 4 more lines; say “bot: more” to see them.",
		]);

		sent.length = 0;
		expect(outbox.more()).toBe(true);
		expect(sent).toEqual([
			"4",
			"5",
			"6",
			"notice: … 1 more line; say “bot: more” to see it.",
		]);

		sent.length = 0;
		expect(outbox.more()).toBe(true);
		expect(sent).toEqual(["7"]);
		expect(outbox.more()).toBe(false);
	});

	test("count the lines a split makes", () => {
		const { sent, outbox } = setup({ maxLines: 2, budget: 10 });

		outbox.reply("aaaa bbbb cccc dddd");
		expect(sent).toEqual(["aaaa bbbb", "cccc dddd"]);
	});

	test("a limit of 0 sends everything", () => {
		const { sent, outbox } = setup({ maxLines: 0 });

		outbox.reply("1\n2\n3\n4\n5");
		expect(sent).toEqual(["1", "2", "3", "4", "5"]);
	});

	test("what was held is dropped when the turn ends", () => {
		const { outbox } = setup();

		outbox.reply("1\n2\n3\n4");
		outbox.endTurn();
		expect(outbox.more()).toBe(false);
	});
});

describe("streamed replies", () => {
	test("go out a finished line at a time, the last after a quiet spell", async () => {
		const { clock, sent, outbox } = setup({ maxLines: 10 });

		outbox.appendReply("Hel");
		outbox.appendReply("lo\nwor");
		expect(sent).toEqual(["Hello"]);

		outbox.appendReply("ld");
		await clock.advance(1999);
		expect(sent).toEqual(["Hello"]);
		await clock.advance(1);
		expect(sent).toEqual(["Hello", "world"]);
	});

	test("stop at the limit and say the reply goes on", async () => {
		const { clock, sent, outbox } = setup({ maxLines: 2 });

		outbox.appendReply("a\nb\nc\n");
		outbox.appendReply("d\n");
		await clock.advance(2000);
		expect(sent).toEqual([
			"a",
			"b",
			"notice: … the reply goes on; say “bot: more” to see more.",
		]);

		sent.length = 0;
		outbox.more();
		expect(sent).toEqual(["c", "d"]);
	});

	test("a code fence split across chunks is still a fence", () => {
		const { sent, outbox } = setup({ maxLines: 10 });

		outbox.appendReply("``");
		outbox.appendReply("`\n**x**\n```\n**y**\n");
		expect(sent).toEqual(["**x**", "y"]);
	});
});

describe("tool calls", () => {
	test("close together share one notice; only a failure is told after", async () => {
		const { clock, sent, outbox } = setup();

		outbox.toolCall({ id: "1", title: "Read `a.ts`", kind: "read" });
		outbox.toolCall({ id: "2", title: "Run tests", kind: "execute" });
		outbox.toolCall({ id: "1", status: "completed" });
		await clock.advance(1500);
		expect(sent).toEqual(["notice: 📖 Read `a.ts` · 💻 Run tests"]);

		outbox.toolCall({ id: "2", status: "failed" });
		expect(sent.at(-1)).toBe("notice: ❌ 💻 Run tests failed");
	});

	test("are sent before the reply that follows them", () => {
		const { sent, outbox } = setup();

		outbox.toolCall({ id: "1", title: "Search", kind: "search" });
		outbox.reply("Found it.");
		expect(sent).toEqual(["notice: 🔍 Search", "Found it."]);
	});
});

test("a question's lines are all sent, whatever the limit", () => {
	const { sent, outbox } = setup({ maxLines: 1 });

	outbox.lines(["Q?", "  1. a", "  2. b", "Reply with a number."]);
	expect(sent).toHaveLength(4);
});
