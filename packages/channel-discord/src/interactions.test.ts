import { expect, test } from "bun:test";
import type { ChannelInteractionPrompt } from "@acpantenna/channel";
import {
	answeredContent,
	answerFromComponent,
	answerFromModal,
	answerFromText,
	createPendingInteraction,
	customId,
	describeAnswer,
	expiredContent,
	formModal,
	modalValues,
	parseCustomId,
	renderInteraction,
} from "./interactions.ts";

const permission: ChannelInteractionPrompt = {
	id: "perm-1",
	kind: "permission",
	options: [
		{ id: "allow", label: "Allow once", kind: "allow" },
		{ id: "always", label: "Always allow", kind: "allow" },
		{ id: "reject", label: "Reject", kind: "reject" },
	],
};

const form: ChannelInteractionPrompt = {
	id: "form-1",
	kind: "elicitation",
	message: "Deploy settings",
	fields: [
		{ name: "env", type: "string", required: true, enum: ["staging", "prod"] },
		{ name: "replicas", type: "integer", required: true, title: "Replicas" },
		{ name: "notes", type: "string", required: false },
	],
};

function pendingOf(prompt: ChannelInteractionPrompt) {
	return createPendingInteraction({
		prompt,
		key: "k1",
		channelId: "200",
		expiresAt: Date.now() + 60_000,
	});
}

type Row = { type: number; components: Array<Record<string, unknown>> };

test("a permission is a row of buttons coloured by what they do", () => {
	const content = renderInteraction("Run `rm -rf build`?", permission, "k1");
	const rows = content.components as Row[];

	expect(content.content).toBe(
		"Run `rm -rf build`?\n-# Tap a button, or reply with its number.",
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.components).toEqual([
		{
			type: 2,
			custom_id: "acpantenna:k1:o0",
			label: "1. Allow once",
			style: 3,
		},
		{
			type: 2,
			custom_id: "acpantenna:k1:o1",
			label: "2. Always allow",
			style: 3,
		},
		{ type: 2, custom_id: "acpantenna:k1:o2", label: "3. Reject", style: 4 },
	]);
});

test("many choices wrap into rows of five, and long labels are listed in the text", () => {
	const prompt: ChannelInteractionPrompt = {
		id: "q",
		kind: "elicitation",
		options: Array.from({ length: 7 }, (_, i) => ({
			id: `c${i}`,
			label: i === 0 ? "x".repeat(100) : `Choice ${i}`,
			kind: "choice" as const,
		})),
	};
	const content = renderInteraction("Pick one", prompt, "k1");
	const rows = content.components as Row[];

	expect(rows.map((row) => row.components.length)).toEqual([5, 3]);
	expect(rows[1]?.components.at(-1)).toMatchObject({
		custom_id: "acpantenna:k1:decline",
		label: "Decline",
	});
	expect((rows[0]?.components[0]?.label as string).length).toBe(80);
	expect(content.content).toContain(`1. ${"x".repeat(100)}`);
	expect(content.content).toContain("7. Choice 6");
});

test("a question with fields gets a form button, and its fields in the text", () => {
	const content = renderInteraction("Deploy settings", form, "k1");
	const buttons = (content.components as Row[])[0]?.components;

	expect(buttons?.map((entry) => entry.custom_id)).toEqual([
		"acpantenna:k1:form",
		"acpantenna:k1:decline",
	]);
	expect(content.content).toContain("• env — one of staging, prod");
	expect(content.content).toContain("• notes (optional)");
});

test("custom IDs name the prompt and the action", () => {
	expect(customId("k1", { kind: "option", index: 12 })).toBe(
		"acpantenna:k1:o12",
	);
	expect(parseCustomId("acpantenna:k1:o12")).toEqual({
		key: "k1",
		action: { kind: "option", index: 12 },
	});
	expect(parseCustomId("acpantenna:k1:decline")?.action).toEqual({
		kind: "decline",
	});
	expect(parseCustomId("someone-else:k1:o1")).toBeUndefined();
	expect(parseCustomId("acpantenna:k1:drop")).toBeUndefined();
});

test("a button press answers with its option, a decline, or opens the form", () => {
	const pending = pendingOf(permission);

	expect(answerFromComponent(pending, { kind: "option", index: 2 })).toEqual({
		id: "perm-1",
		optionId: "reject",
	});
	expect(
		answerFromComponent(pending, { kind: "option", index: 9 }),
	).toBeUndefined();
	// A permission cannot be declined, only rejected.
	expect(answerFromComponent(pending, { kind: "decline" })).toBeUndefined();
	expect(answerFromComponent(pendingOf(form), { kind: "decline" })).toEqual({
		id: "form-1",
		declined: true,
	});
	expect(answerFromComponent(pendingOf(form), { kind: "form" })).toBe("form");
});

test("the form has one input per field, and its answers are checked", () => {
	const pending = pendingOf(form);
	const modal = formModal(pending) as {
		custom_id: string;
		title: string;
		components: Row[];
	};

	expect(modal.custom_id).toBe("acpantenna:k1:form");
	expect(modal.title).toBe("Deploy settings");
	expect(modal.components.map((row) => row.components[0])).toEqual([
		{
			type: 4,
			custom_id: "f0",
			label: "env",
			style: 1,
			required: true,
			placeholder: "One of staging, prod",
		},
		{ type: 4, custom_id: "f1", label: "Replicas", style: 1, required: true },
		{ type: 4, custom_id: "f2", label: "notes", style: 2, required: false },
	]);

	const submitted = (env: string, replicas: string) =>
		modalValues([
			{ type: 1, components: [{ type: 4, custom_id: "f0", value: env }] },
			// The newer layout: a label holding its input.
			{ type: 18, component: { type: 4, custom_id: "f1", value: replicas } },
			{ type: 1, components: [{ type: 4, custom_id: "f2", value: "" }] },
		]);

	expect(answerFromModal(pending, submitted("Prod", "3"))).toEqual({
		response: { id: "form-1", content: { env: "prod", replicas: 3 } },
	});
	expect(answerFromModal(pending, submitted("qa", "3"))).toEqual({
		problem: "env: one of staging, prod.",
	});
	expect(answerFromModal(pending, submitted("prod", "2.5"))).toEqual({
		problem: "Replicas: a whole number.",
	});
	expect(answerFromModal(pending, submitted("prod", ""))).toEqual({
		problem: "Replicas is required.",
	});
});

test("a typed reply answers too: a number, a label, yes or no, or form lines", () => {
	const pending = pendingOf(permission);

	expect(answerFromText(pending, "3")?.optionId).toBe("reject");
	expect(answerFromText(pending, "always allow")?.optionId).toBe("always");
	expect(answerFromText(pending, "yes")?.optionId).toBe("allow");
	expect(answerFromText(pending, "No.")?.optionId).toBe("reject");
	expect(answerFromText(pending, "what does it do?")).toBeUndefined();

	const deploy = pendingOf(form);
	expect(answerFromText(deploy, "env: staging\nReplicas: 2")).toEqual({
		id: "form-1",
		content: { env: "staging", replicas: 2 },
	});
	expect(answerFromText(deploy, "decline")).toEqual({
		id: "form-1",
		declined: true,
	});
	expect(answerFromText(deploy, "env: staging")).toBeUndefined();
});

test("an answered prompt shows the answer and loses its buttons and hint", () => {
	const pending = pendingOf(permission);
	const shown = renderInteraction("Run it?", permission, "k1").content;
	const chosen = describeAnswer(pending, { id: "perm-1", optionId: "allow" });

	expect(answeredContent(shown, chosen, "<@42>")).toEqual({
		content: "Run it?\n→ **Allow once** (<@42>)",
		components: [],
	});
	expect(expiredContent(shown)).toEqual({
		content: "Run it?\n-# This question is no longer open.",
		components: [],
	});
	expect(describeAnswer(pending, { id: "perm-1", declined: true })).toBe(
		"declined",
	);
});
