import { describe, expect, test } from "bun:test";
import type { ChannelInteractionPrompt } from "@acpantenna/channel";
import {
	answeredPrompt,
	answerFromCallback,
	answerFromText,
	callbackData,
	createPendingInteraction,
	describeAnswer,
	parseCallbackData,
	randomToken,
	renderInteraction,
} from "./interactions.ts";

const permission: ChannelInteractionPrompt = {
	id: "perm-1",
	kind: "permission",
	message: "Run `rm -rf build`?",
	options: [
		{ id: "allow-once", label: "Allow once", kind: "allow" },
		{ id: "allow-always", label: "Allow always", kind: "allow" },
		{ id: "reject-once", label: "Reject", kind: "reject" },
	],
};

const form: ChannelInteractionPrompt = {
	id: "form-1",
	kind: "elicitation",
	message: "Tell me about the release",
	fields: [
		{ name: "version", type: "string", required: true, title: "Version" },
		{ name: "replicas", type: "integer", required: false },
		{ name: "notify", type: "boolean", required: false },
	],
};

const pending = (prompt: ChannelInteractionPrompt) =>
	createPendingInteraction(prompt, Number.MAX_SAFE_INTEGER, "tok1");

describe("callback data", () => {
	test("fits Telegram's 64 bytes and parses back", () => {
		const token = randomToken();

		expect(token).toMatch(/^[a-z0-9]{8}$/);
		expect(callbackData(token, 12).length).toBeLessThanOrEqual(64);
		expect(parseCallbackData(callbackData(token, 2))).toEqual({
			token,
			choice: 2,
		});
		expect(parseCallbackData("a:tok1:d")).toEqual({
			token: "tok1",
			choice: "decline",
		});
		expect(parseCallbackData("something else")).toBeUndefined();
		expect(parseCallbackData("a:TOK:1")).toBeUndefined();
	});
});

describe("rendering", () => {
	test("a permission is its question, with a button per option", () => {
		const rendered = renderInteraction(
			`🔒 ${permission.message}`,
			pending(permission),
		);

		expect(rendered.html).toBe("🔒 Run <code>rm -rf build</code>?");
		expect(rendered.text).toBe("🔒 Run `rm -rf build`?");
		expect(rendered.keyboard).toEqual({
			inline_keyboard: [
				[
					{ text: "✅ Allow once", callback_data: "a:tok1:0" },
					{ text: "✅ Allow always", callback_data: "a:tok1:1" },
				],
				[{ text: "❌ Reject", callback_data: "a:tok1:2" }],
			],
		});
	});

	test("long labels get a row each", () => {
		const rendered = renderInteraction("Pick", {
			token: "t",
			kind: "elicitation",
			fields: [],
			options: [
				{ id: "a", label: "The first, rather long choice", kind: "choice" },
				{ id: "b", label: "Second", kind: "choice" },
			],
		});

		expect(rendered.keyboard?.inline_keyboard).toHaveLength(2);
	});

	test("a form lists its fields, says how to answer, and offers Decline", () => {
		const rendered = renderInteraction(form.message ?? "", pending(form));

		expect(rendered.text).toBe(
			[
				"Tell me about the release",
				"• Version",
				"• replicas (optional)",
				"• notify (optional)",
				"Reply to this message with one “name: value” line per field, or tap Decline.",
			].join("\n"),
		);
		expect(rendered.html).toContain("<i>Reply to this message");
		expect(rendered.keyboard).toEqual({
			inline_keyboard: [[{ text: "Decline", callback_data: "a:tok1:d" }]],
		});
	});

	test("the answered prompt says what was chosen and by whom", () => {
		const shown = renderInteraction("Run <it>?", pending(permission));

		expect(answeredPrompt(shown, "Allow once", "Ada <3")).toEqual({
			html: "Run &lt;it&gt;?\n\n→ <b>Allow once</b> (Ada &lt;3)",
			text: "Run <it>?\n\n→ Allow once (Ada <3)",
		});
	});
});

describe("answers", () => {
	test("a button picks its option; another prompt's button picks nothing", () => {
		const waiting = pending(permission);

		expect(answerFromCallback(waiting, "a:tok1:2")).toEqual({
			id: "perm-1",
			optionId: "reject-once",
		});
		expect(answerFromCallback(waiting, "a:other:0")).toBeUndefined();
		expect(answerFromCallback(waiting, "a:tok1:9")).toBeUndefined();
		// A permission cannot be declined, only rejected.
		expect(answerFromCallback(waiting, "a:tok1:d")).toBeUndefined();
		expect(answerFromCallback(pending(form), "a:tok1:d")).toEqual({
			id: "form-1",
			declined: true,
		});
	});

	test("a reply with a number, a label, or yes / no", () => {
		const waiting = pending(permission);

		expect(answerFromText(waiting, "2")?.optionId).toBe("allow-always");
		expect(answerFromText(waiting, "reject")?.optionId).toBe("reject-once");
		expect(answerFromText(waiting, "Yes!")?.optionId).toBe("allow-once");
		expect(answerFromText(waiting, "no")?.optionId).toBe("reject-once");
		expect(answerFromText(waiting, "what does it do?")).toBeUndefined();
	});

	test("a form from name: value lines, typed", () => {
		const waiting = pending(form);

		expect(
			answerFromText(waiting, "Version: 1.2.0\nreplicas: 3\nnotify: yes"),
		).toEqual({
			id: "form-1",
			content: { version: "1.2.0", replicas: 3, notify: true },
		});
		expect(answerFromText(waiting, "replicas: 3")).toBeUndefined();
		expect(answerFromText(waiting, "decline")).toEqual({
			id: "form-1",
			declined: true,
		});
	});

	test("what the edited prompt shows", () => {
		expect(
			describeAnswer(pending(permission), {
				id: "perm-1",
				optionId: "allow-once",
			}),
		).toBe("Allow once");
		expect(
			describeAnswer(pending(form), { id: "form-1", declined: true }),
		).toBe("declined");
	});
});
