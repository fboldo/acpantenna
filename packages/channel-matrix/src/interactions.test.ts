import { describe, expect, test } from "bun:test";
import type { ChannelInteractionPrompt } from "@acpantenna/channel";
import {
	answerFromReaction,
	answerFromText,
	createPendingInteraction,
	describeAnswer,
	reactionKeys,
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

const choice: ChannelInteractionPrompt = {
	id: "pick-1",
	kind: "elicitation",
	message: "Which environment?",
	options: [
		{ id: "staging", label: "Staging", kind: "choice" },
		{ id: "production", label: "Production", kind: "choice" },
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
	createPendingInteraction(prompt, Number.MAX_SAFE_INTEGER);

describe("reaction keys", () => {
	test("✅ for the first allow, ❌ for the first reject", () => {
		expect(reactionKeys(permission.options ?? [])).toEqual([
			{ key: "✅", optionId: "allow-once" },
			{ key: "❌", optionId: "reject-once" },
		]);
	});

	test("a numbered keycap for each choice", () => {
		expect(reactionKeys(choice.options ?? [])).toEqual([
			{ key: "1️⃣", optionId: "staging" },
			{ key: "2️⃣", optionId: "production" },
		]);
	});
});

describe("rendering", () => {
	test("a permission lists its options with the reactions to tap", () => {
		const rendered = renderInteraction(`🔒 ${permission.message}`, permission);

		expect(rendered.body).toBe(
			[
				"🔒 Run `rm -rf build`?",
				"1. ✅ Allow once",
				"2. Allow always",
				"3. ❌ Reject",
				"React with ✅ or ❌, or reply with a number.",
			].join("\n"),
		);
		expect(rendered.formatted_body).toContain("<code>rm -rf build</code>");
		expect(rendered.formatted_body).toContain(
			"<ol><li>✅ Allow once</li><li>Allow always</li><li>❌ Reject</li></ol>",
		);
	});

	test("a form lists its fields and how to answer", () => {
		const rendered = renderInteraction(`📝 ${form.message}`, form);

		expect(rendered.body).toContain("• Version");
		expect(rendered.body).toContain("• replicas (optional)");
		expect(rendered.body).toContain("one “name: value” line per field");
	});

	test("labels are escaped in the HTML", () => {
		const rendered = renderInteraction("pick", {
			id: "x",
			kind: "elicitation",
			options: [{ id: "a", label: "<img src=x>", kind: "choice" }],
		});

		expect(rendered.formatted_body).toContain("&lt;img src=x&gt;");
		expect(rendered.formatted_body).not.toContain("<img");
	});
});

describe("answers from reactions", () => {
	test("the prompt's own keys, with or without a variation selector", () => {
		expect(answerFromReaction(pending(permission), "✅")).toEqual({
			id: "perm-1",
			optionId: "allow-once",
		});
		expect(answerFromReaction(pending(permission), "✅️")).toEqual({
			id: "perm-1",
			optionId: "allow-once",
		});
		expect(answerFromReaction(pending(permission), "❌")).toEqual({
			id: "perm-1",
			optionId: "reject-once",
		});
		expect(answerFromReaction(pending(choice), "2️⃣")).toEqual({
			id: "pick-1",
			optionId: "production",
		});
	});

	test("thumbs up and down count as allow and reject", () => {
		expect(answerFromReaction(pending(permission), "👍")?.optionId).toBe(
			"allow-once",
		);
		expect(answerFromReaction(pending(permission), "👎")?.optionId).toBe(
			"reject-once",
		);
	});

	test("other reactions are not answers", () => {
		expect(answerFromReaction(pending(permission), "🎉")).toBeUndefined();
		expect(answerFromReaction(pending(choice), "✅")).toBeUndefined();
		expect(answerFromReaction(pending(choice), "3️⃣")).toBeUndefined();
	});
});

describe("answers from replies", () => {
	test("an option's number or label", () => {
		expect(answerFromText(pending(permission), "2")?.optionId).toBe(
			"allow-always",
		);
		expect(answerFromText(pending(permission), " 3. ")?.optionId).toBe(
			"reject-once",
		);
		expect(answerFromText(pending(permission), "allow ALWAYS")?.optionId).toBe(
			"allow-always",
		);
		expect(answerFromText(pending(choice), "production")?.optionId).toBe(
			"production",
		);
	});

	test("yes and no for a permission", () => {
		expect(answerFromText(pending(permission), "yes")?.optionId).toBe(
			"allow-once",
		);
		expect(answerFromText(pending(permission), "No")?.optionId).toBe(
			"reject-once",
		);
	});

	test("anything else goes to the agent", () => {
		expect(answerFromText(pending(permission), "9")).toBeUndefined();
		expect(
			answerFromText(pending(permission), "what does this do?"),
		).toBeUndefined();
	});

	test("form values, typed by the field", () => {
		expect(
			answerFromText(pending(form), "Version: 1.2.0\nreplicas: 3\nnotify: yes"),
		).toEqual({
			id: "form-1",
			content: { version: "1.2.0", replicas: 3, notify: true },
		});
	});

	test("a form missing a required field, or with a bad value, is not an answer", () => {
		expect(answerFromText(pending(form), "replicas: 3")).toBeUndefined();
		expect(
			answerFromText(pending(form), "version: 1\nreplicas: lots"),
		).toBeUndefined();
	});

	test("a one-field form takes the whole reply", () => {
		const single = pending({
			id: "one",
			kind: "elicitation",
			fields: [
				{
					name: "size",
					type: "string",
					required: true,
					enum: ["s", "m", "l"],
					enumTitles: ["Small", "Medium", "Large"],
				},
			],
		});

		expect(answerFromText(single, "medium")).toEqual({
			id: "one",
			content: { size: "m" },
		});
		expect(answerFromText(single, "huge")).toBeUndefined();
	});

	test("decline turns an elicitation down", () => {
		expect(answerFromText(pending(form), "decline")).toEqual({
			id: "form-1",
			declined: true,
		});
		expect(answerFromText(pending(choice), "Skip.")).toEqual({
			id: "pick-1",
			declined: true,
		});
	});

	test("an answer reads back as what was chosen", () => {
		expect(
			describeAnswer(pending(permission), {
				id: "perm-1",
				optionId: "allow-always",
			}),
		).toBe("Allow always");
		expect(
			describeAnswer(pending(form), {
				id: "form-1",
				content: { version: "1.2.0" },
			}),
		).toBe("version: 1.2.0");
	});
});
