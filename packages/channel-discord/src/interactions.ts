import type {
	ChannelElicitationField,
	ChannelInteractionOption,
	ChannelInteractionPrompt,
	ChannelInteractionResponse,
} from "@acpantenna/channel";
import { MAX_MESSAGE_CHARS, truncate } from "./format.ts";
import type { MessageContent } from "./live-message.ts";

/** An interaction shown in a channel, waiting for an answer. */
export interface PendingInteraction {
	id: string;
	/** Short key in the buttons' custom IDs (which Discord caps at 100 characters). */
	key: string;
	kind: ChannelInteractionPrompt["kind"];
	message?: string;
	options: ChannelInteractionOption[];
	fields: ChannelElicitationField[];
	channelId: string;
	/** The message the prompt was sent as, once it is sent. */
	messageId?: string;
	/** What that message says, to add the answer to. */
	content?: string;
	/** Epoch ms after which the gateway has given up on it. */
	expiresAt: number;
}

/** What a button (or a form's submit) of a prompt does. */
export type ComponentAction =
	| { kind: "option"; index: number }
	| { kind: "decline" }
	| { kind: "form" };

export const CUSTOM_ID_PREFIX = "acpantenna";

/** Discord's caps on what a message's buttons and a form may hold. */
const MAX_BUTTONS = 25;
const BUTTONS_PER_ROW = 5;
const MAX_BUTTON_LABEL = 80;
const MAX_FORM_FIELDS = 5;
const MAX_FORM_LABEL = 45;
const MAX_PLACEHOLDER = 100;

const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4 };
const ComponentType = { ActionRow: 1, Button: 2, TextInput: 4 };
const TextInputStyle = { Short: 1, Paragraph: 2 };

const ALLOW_WORDS = ["yes", "y", "allow", "ok", "approve"];
const REJECT_WORDS = ["no", "n", "deny", "reject"];
const DECLINE_WORDS = ["decline", "skip"];

export function createPendingInteraction(input: {
	prompt: ChannelInteractionPrompt;
	key: string;
	channelId: string;
	expiresAt: number;
}): PendingInteraction {
	return {
		id: input.prompt.id,
		key: input.key,
		kind: input.prompt.kind,
		message: input.prompt.message,
		options: input.prompt.options ?? [],
		fields: input.prompt.fields ?? [],
		channelId: input.channelId,
		expiresAt: input.expiresAt,
	};
}

export function customId(key: string, action: ComponentAction): string {
	const suffix =
		action.kind === "option" ? `o${action.index}` : (action.kind as string);
	return `${CUSTOM_ID_PREFIX}:${key}:${suffix}`;
}

/** The prompt and action a button's custom ID names, or undefined if it is not one of ours. */
export function parseCustomId(
	id: string,
): { key: string; action: ComponentAction } | undefined {
	const match = new RegExp(
		`^${CUSTOM_ID_PREFIX}:([\\w-]+):(o\\d+|decline|form)$`,
	).exec(id);

	if (!match?.[1] || !match[2]) {
		return undefined;
	}

	const suffix = match[2];
	const action: ComponentAction = suffix.startsWith("o")
		? { kind: "option", index: Number(suffix.slice(1)) }
		: { kind: suffix as "decline" | "form" };

	return { key: match[1], action };
}

/** Whether a prompt's form can be a Discord form (a modal): five fields at most. */
function hasForm(pending: Pick<PendingInteraction, "options" | "fields">) {
	return (
		pending.options.length === 0 &&
		pending.fields.length > 0 &&
		pending.fields.length <= MAX_FORM_FIELDS
	);
}

/**
 * The prompt as a message with buttons: one per option (green for allow,
 * red for reject), "Answer…" opening a form for a question with fields, and
 * "Decline" for a question. What does not fit in buttons is spelled out in
 * the text, to be answered by a reply.
 */
export function renderInteraction(
	text: string,
	prompt: ChannelInteractionPrompt,
	key: string,
): MessageContent {
	const pending = {
		options: prompt.options ?? [],
		fields: prompt.fields ?? [],
	};
	const buttons: Array<Record<string, unknown>> = [];
	const lines: string[] = [text.trim() || "The agent is asking:"];
	const shown = pending.options.slice(0, MAX_BUTTONS - 1);
	const listOptions =
		pending.options.length > shown.length ||
		pending.options.some((option) => option.label.length > MAX_BUTTON_LABEL);

	shown.forEach((option, index) => {
		buttons.push(
			button(
				customId(key, { kind: "option", index }),
				truncate(`${index + 1}. ${option.label}`, MAX_BUTTON_LABEL),
				option.kind === "allow"
					? ButtonStyle.Success
					: option.kind === "reject"
						? ButtonStyle.Danger
						: ButtonStyle.Secondary,
			),
		);
	});

	if (listOptions) {
		pending.options.forEach((option, index) => {
			lines.push(`${index + 1}. ${option.label}`);
		});
	}

	if (pending.options.length === 0) {
		for (const field of pending.fields) {
			lines.push(`• ${describeField(field)}`);
		}
	}

	if (hasForm(pending)) {
		buttons.push(
			button(customId(key, { kind: "form" }), "Answer…", ButtonStyle.Primary),
		);
	}

	if (prompt.kind === "elicitation") {
		buttons.push(
			button(
				customId(key, { kind: "decline" }),
				"Decline",
				ButtonStyle.Secondary,
			),
		);
	}

	lines.push(`-# ${answerHint(pending, listOptions)}`);

	return {
		content: clip(lines.join("\n"), MAX_MESSAGE_CHARS),
		components: rows(buttons),
	};
}

function button(
	id: string,
	label: string,
	style: number,
): Record<string, unknown> {
	return { type: ComponentType.Button, custom_id: id, label, style };
}

function rows(
	components: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const result: Array<Record<string, unknown>> = [];

	for (let at = 0; at < components.length; at += BUTTONS_PER_ROW) {
		result.push({
			type: ComponentType.ActionRow,
			components: components.slice(at, at + BUTTONS_PER_ROW),
		});
	}

	return result;
}

function describeField(field: ChannelElicitationField): string {
	const name = field.title ?? field.name;
	const choices = field.enum
		? ` — one of ${(field.enumTitles ?? field.enum.map(String)).join(", ")}`
		: "";
	const required = field.required ? "" : " (optional)";
	const description = field.description ? `: ${field.description}` : "";

	return `${name}${required}${description}${choices}`;
}

function answerHint(
	pending: Pick<PendingInteraction, "options" | "fields">,
	listOptions: boolean,
): string {
	if (pending.options.length > 0) {
		return listOptions
			? "Tap a button, or reply with a number."
			: "Tap a button, or reply with its number.";
	}

	if (hasForm(pending)) {
		return "Tap Answer…, or reply with the answer (one “name: value” line per field).";
	}

	return pending.fields.length === 1
		? "Reply with the answer, or “decline”."
		: "Reply with one “name: value” line per field, or “decline”.";
}

/** `text` cut to `limit` characters, the cut marked. */
function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * What a button press answers: an option, or a decline. `form` for the
 * button that opens the question's form, which is not an answer yet.
 */
export function answerFromComponent(
	pending: PendingInteraction,
	action: ComponentAction,
): ChannelInteractionResponse | "form" | undefined {
	switch (action.kind) {
		case "option": {
			const option = pending.options[action.index];
			return option ? { id: pending.id, optionId: option.id } : undefined;
		}
		case "decline":
			return pending.kind === "elicitation"
				? { id: pending.id, declined: true }
				: undefined;
		case "form":
			return hasForm(pending) ? "form" : undefined;
		default:
			return undefined;
	}
}

/** The form (a Discord modal) for a question's fields, one text input each. */
export function formModal(
	pending: PendingInteraction,
): Record<string, unknown> {
	return {
		custom_id: customId(pending.key, { kind: "form" }),
		title: truncate(pending.message || "The agent is asking", MAX_FORM_LABEL),
		components: pending.fields.slice(0, MAX_FORM_FIELDS).map((field, index) => {
			const hint = field.enum
				? `One of ${(field.enumTitles ?? field.enum.map(String)).join(", ")}`
				: field.type === "boolean"
					? "yes or no"
					: field.description;

			return {
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.TextInput,
						custom_id: `f${index}`,
						label: truncate(field.title ?? field.name, MAX_FORM_LABEL),
						style:
							field.type === "string" && !field.enum
								? TextInputStyle.Paragraph
								: TextInputStyle.Short,
						required: field.required,
						...(hint ? { placeholder: truncate(hint, MAX_PLACEHOLDER) } : {}),
					},
				],
			};
		}),
	};
}

/** The values a submitted modal carries, by input custom ID. */
export function modalValues(components: unknown): Map<string, string> {
	const values = new Map<string, string>();
	const visit = (node: unknown) => {
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}

		if (!node || typeof node !== "object") {
			return;
		}

		const entry = node as {
			custom_id?: unknown;
			value?: unknown;
			component?: unknown;
			components?: unknown;
		};

		if (
			typeof entry.custom_id === "string" &&
			typeof entry.value === "string"
		) {
			values.set(entry.custom_id, entry.value);
		}

		visit(entry.component);
		visit(entry.components);
	};

	visit(components);
	return values;
}

/**
 * The answer a submitted form gives, or what is wrong with it, to show the
 * person who sent it (their answer is not passed on until it is right).
 */
export function answerFromModal(
	pending: PendingInteraction,
	values: Map<string, string>,
): { response: ChannelInteractionResponse } | { problem: string } {
	const content: Record<string, FormValue> = {};

	for (const [index, field] of pending.fields.entries()) {
		const value = values.get(`f${index}`)?.trim() ?? "";
		const name = field.title ?? field.name;

		if (value === "") {
			if (field.required) {
				return { problem: `${name} is required.` };
			}

			continue;
		}

		const coerced = coerceField(field, value);

		if (coerced === undefined) {
			return { problem: `${name}: ${expected(field)}` };
		}

		content[field.name] = coerced;
	}

	return { response: { id: pending.id, content } };
}

function expected(field: ChannelElicitationField): string {
	if (field.enum) {
		return `one of ${(field.enumTitles ?? field.enum.map(String)).join(", ")}.`;
	}

	switch (field.type) {
		case "integer":
			return "a whole number.";
		case "number":
			return "a number.";
		case "boolean":
			return "yes or no.";
		default:
			return "not a valid answer.";
	}
}

/**
 * The answer a plain reply gives: an option's number or label (or yes / no
 * for a permission), or form values. Anything else is not an answer and goes
 * to the agent as a normal message.
 */
export function answerFromText(
	pending: PendingInteraction,
	text: string,
): ChannelInteractionResponse | undefined {
	const reply = text.trim();
	const word = reply.toLowerCase().replace(/[.!)]+$/, "");

	if (pending.kind === "elicitation" && DECLINE_WORDS.includes(word)) {
		return { id: pending.id, declined: true };
	}

	if (pending.options.length > 0) {
		const optionId = optionFromText(pending.options, word);
		return optionId ? { id: pending.id, optionId } : undefined;
	}

	const content = formFromText(pending.fields, reply);
	return content ? { id: pending.id, content } : undefined;
}

function optionFromText(
	options: ChannelInteractionOption[],
	word: string,
): string | undefined {
	if (/^\d+$/.test(word)) {
		return options[Number(word) - 1]?.id;
	}

	const byLabel = options.find(
		(option) => option.label.trim().toLowerCase() === word,
	);

	if (byLabel) {
		return byLabel.id;
	}

	const kind = ALLOW_WORDS.includes(word)
		? "allow"
		: REJECT_WORDS.includes(word)
			? "reject"
			: undefined;

	return kind ? options.find((option) => option.kind === kind)?.id : undefined;
}

type FormValue = string | number | boolean;

function formFromText(
	fields: ChannelElicitationField[],
	reply: string,
): Record<string, FormValue> | undefined {
	if (fields.length === 0 || reply === "") {
		return undefined;
	}

	const raw = new Map<string, string>();
	const [onlyField] = fields;

	if (fields.length === 1 && onlyField) {
		const prefixed = splitNamedLine(reply, fields);
		raw.set(onlyField.name, prefixed?.[1] ?? reply);
	} else {
		for (const line of reply.split("\n")) {
			const named = splitNamedLine(line, fields);

			if (named) {
				raw.set(named[0], named[1]);
			}
		}
	}

	const content: Record<string, FormValue> = {};

	for (const field of fields) {
		const value = raw.get(field.name);

		if (value === undefined || value === "") {
			if (field.required) {
				return undefined;
			}

			continue;
		}

		const coerced = coerceField(field, value);

		if (coerced === undefined) {
			return undefined;
		}

		content[field.name] = coerced;
	}

	return content;
}

/** `name: value`, where name is a field's name or title. */
function splitNamedLine(
	line: string,
	fields: ChannelElicitationField[],
): [string, string] | undefined {
	const separator = line.indexOf(":");

	if (separator <= 0) {
		return undefined;
	}

	const name = line.slice(0, separator).trim().toLowerCase();
	const field = fields.find(
		(entry) =>
			entry.name.toLowerCase() === name || entry.title?.toLowerCase() === name,
	);

	return field ? [field.name, line.slice(separator + 1).trim()] : undefined;
}

function coerceField(
	field: ChannelElicitationField,
	value: string,
): FormValue | undefined {
	if (field.enum) {
		const lowered = value.toLowerCase();
		const index = field.enum.findIndex(
			(entry, position) =>
				String(entry).toLowerCase() === lowered ||
				field.enumTitles?.[position]?.toLowerCase() === lowered,
		);

		return index === -1 ? undefined : field.enum[index];
	}

	if (field.type === "number" || field.type === "integer") {
		const number = Number(value);

		if (!Number.isFinite(number)) {
			return undefined;
		}

		return field.type === "integer" && !Number.isInteger(number)
			? undefined
			: number;
	}

	if (field.type === "boolean") {
		const lowered = value.toLowerCase();

		if (["yes", "y", "true", "1", "on"].includes(lowered)) {
			return true;
		}

		if (["no", "n", "false", "0", "off"].includes(lowered)) {
			return false;
		}

		return undefined;
	}

	return value;
}

/** How an answered prompt reads once it is edited: what was chosen. */
export function describeAnswer(
	pending: PendingInteraction,
	response: ChannelInteractionResponse,
): string {
	if (response.declined) {
		return "declined";
	}

	if (response.optionId) {
		return (
			pending.options.find((option) => option.id === response.optionId)
				?.label ?? response.optionId
		);
	}

	return Object.entries(response.content ?? {})
		.map(([name, value]) => `${name}: ${String(value)}`)
		.join(", ");
}

/** The prompt once answered: its text, what was chosen and by whom, no buttons. */
export function answeredContent(
	shown: string,
	chosen: string,
	by: string,
): MessageContent {
	const answer = `\n→ **${truncate(chosen, 300)}** (${by})`;
	return {
		content: `${clip(withoutHint(shown), MAX_MESSAGE_CHARS - answer.length)}${answer}`,
		components: [],
	};
}

/** A prompt nobody is waiting on any more (it timed out, or the bot restarted). */
export function expiredContent(shown: string): MessageContent {
	const note = "\n-# This question is no longer open.";
	return {
		content: `${clip(withoutHint(shown), MAX_MESSAGE_CHARS - note.length)}${note}`,
		components: [],
	};
}

/** The prompt's text without its last line, the how-to-answer hint. */
function withoutHint(shown: string): string {
	return shown.replace(/\n-# [^\n]*$/, "");
}
