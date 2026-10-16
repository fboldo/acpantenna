import { expect, test } from "bun:test";
import type { ChannelInteractionPrompt } from "@acpantenna/channel";
import {
	answerFromText,
	createPendingInteraction,
	describeAnswer,
	isOptionAnswer,
	renderInteraction,
} from "./interactions.ts";

const permission: ChannelInteractionPrompt = {
	id: "p1",
	kind: "permission",
	message: "Run `rm -rf build`?",
	options: [
		{ id: "allow_once", label: "Allow once", kind: "allow" },
		{ id: "allow_always", label: "Always allow", kind: "allow" },
		{ id: "reject_once", label: "Reject", kind: "reject" },
	],
};

const form: ChannelInteractionPrompt = {
	id: "e1",
	kind: "elicitation",
	message: "Details?",
	fields: [
		{ name: "name", type: "string", required: true, title: "Name" },
		{ name: "count", type: "integer", required: false },
		{ name: "color", type: "string", required: true, enum: ["red", "blue"] },
	],
};

test("a permission is a numbered list with how to answer", () => {
	expect(renderInteraction("🔒 Run `rm -rf build`?", permission)).toEqual([
		"🔒 Run `rm -rf build`?",
		"  1. Allow once",
		"  2. Always allow",
		"  3. Reject",
		"Reply with a number, or yes / no.",
	]);
});

test("a form lists its fields; in a channel the hint says how to address the bot", () => {
	expect(renderInteraction("📝 Details?", form, "bot: ")).toEqual([
		"📝 Details?",
		"  • Name",
		"  • count (optional)",
		"  • color — one of red, blue",
		"Reply “bot: name: value; name: value”, or “bot: decline”.",
	]);
});

test("a permission is answered by number, label or yes / no", () => {
	const pending = createPendingInteraction(permission, 0);

	expect(answerFromText(pending, "2")).toEqual({
		id: "p1",
		optionId: "allow_always",
	});
	expect(answerFromText(pending, "reject")).toEqual({
		id: "p1",
		optionId: "reject_once",
	});
	expect(answerFromText(pending, "Yes!")).toEqual({
		id: "p1",
		optionId: "allow_once",
	});
	expect(answerFromText(pending, "no")).toEqual({
		id: "p1",
		optionId: "reject_once",
	});
	expect(answerFromText(pending, "9")).toBeUndefined();
	expect(answerFromText(pending, "why would you do that")).toBeUndefined();
	expect(isOptionAnswer(pending, "1")).toBe(true);
	expect(isOptionAnswer(pending, "lol")).toBe(false);
	expect(describeAnswer(pending, { id: "p1", optionId: "allow_always" })).toBe(
		"Always allow",
	);
});

test("a form is answered on one line, or declined", () => {
	const pending = createPendingInteraction(form, 0);

	expect(answerFromText(pending, "name: Ada; count: 3; color: Blue")).toEqual({
		id: "e1",
		content: { name: "Ada", count: 3, color: "blue" },
	});
	expect(answerFromText(pending, "Name: Ada; color: green")).toBeUndefined();
	expect(answerFromText(pending, "count: 3")).toBeUndefined();
	expect(answerFromText(pending, "decline")).toEqual({
		id: "e1",
		declined: true,
	});
	expect(isOptionAnswer(pending, "decline")).toBe(false);
});

test("a single-field form takes the reply as it is", () => {
	const pending = createPendingInteraction(
		{
			id: "e2",
			kind: "elicitation",
			fields: [{ name: "ok", type: "boolean", required: true }],
		},
		0,
	);

	expect(answerFromText(pending, "yes")).toEqual({
		id: "e2",
		content: { ok: true },
	});
	expect(answerFromText(pending, "maybe")).toBeUndefined();
});
