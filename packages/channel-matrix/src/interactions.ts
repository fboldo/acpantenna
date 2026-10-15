import type {
	ChannelElicitationField,
	ChannelInteractionOption,
	ChannelInteractionPrompt,
	ChannelInteractionResponse,
} from "@acpantenna/channel";
import { escapeHtml, type FormattedText, formatMarkdown } from "./format.ts";

/** An interaction shown in a room, waiting for an answer. */
export interface PendingInteraction {
	id: string;
	kind: ChannelInteractionPrompt["kind"];
	options: ChannelInteractionOption[];
	fields: ChannelElicitationField[];
	/** The event the prompt was sent as, once it is sent. */
	eventId?: string;
	/** Epoch ms after which the gateway has given up on it. */
	expiresAt: number;
}

export interface ReactionKey {
	key: string;
	optionId: string;
}

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const ALLOW_KEY = "✅";
const REJECT_KEY = "❌";
/** Other reactions people reach for, read as the first allow / reject. */
const ALLOW_ALIASES = ["✅", "✔️", "👍", "☑️"];
const REJECT_ALIASES = ["❌", "✖️", "👎", "🚫"];
const ALLOW_WORDS = ["yes", "y", "allow", "ok", "approve"];
const REJECT_WORDS = ["no", "n", "deny", "reject"];
const DECLINE_WORDS = ["decline", "skip"];

export function createPendingInteraction(
	prompt: ChannelInteractionPrompt,
	expiresAt: number,
): PendingInteraction {
	return {
		id: prompt.id,
		kind: prompt.kind,
		options: prompt.options ?? [],
		fields: prompt.fields ?? [],
		expiresAt,
	};
}

/**
 * The reactions the bot puts under a prompt for one-tap answers: ✅ for the
 * first allow option, ❌ for the first reject, and a keycap with its number
 * for each choice.
 */
export function reactionKeys(
	options: ChannelInteractionOption[],
): ReactionKey[] {
	const keys: ReactionKey[] = [];
	const firstAllow = options.find((option) => option.kind === "allow");
	const firstReject = options.find((option) => option.kind === "reject");

	if (firstAllow) {
		keys.push({ key: ALLOW_KEY, optionId: firstAllow.id });
	}

	if (firstReject) {
		keys.push({ key: REJECT_KEY, optionId: firstReject.id });
	}

	options.forEach((option, index) => {
		const keycap = KEYCAPS[index];

		if (option.kind === "choice" && keycap) {
			keys.push({ key: keycap, optionId: option.id });
		}
	});

	return keys;
}

/** The prompt as a message: the question, the numbered choices, how to answer. */
export function renderInteraction(
	text: string,
	prompt: ChannelInteractionPrompt,
): FormattedText {
	const options = prompt.options ?? [];
	const keys = reactionKeys(options);
	const head = formatMarkdown(text);
	const headHtml = head.formatted_body ?? escapeHtml(head.body);
	const lines: string[] = [];
	const items: string[] = [];

	options.forEach((option, index) => {
		const key = keys.find((entry) => entry.optionId === option.id)?.key;
		const label =
			key && option.kind !== "choice" ? `${key} ${option.label}` : option.label;

		lines.push(`${index + 1}. ${label}`);
		items.push(`<li>${escapeHtml(label)}</li>`);
	});

	if (options.length === 0) {
		for (const field of prompt.fields ?? []) {
			const line = describeField(field);

			lines.push(`• ${line}`);
			items.push(`<li>${escapeHtml(line)}</li>`);
		}
	}

	const hint = answerHint(prompt, keys);
	const list =
		items.length === 0
			? ""
			: options.length > 0
				? `<ol>${items.join("")}</ol>`
				: `<ul>${items.join("")}</ul>`;

	return {
		body: [head.body, ...lines, hint].join("\n"),
		format: "org.matrix.custom.html",
		formatted_body: `${headHtml}${list}<p><em>${escapeHtml(hint)}</em></p>`,
	};
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
	prompt: ChannelInteractionPrompt,
	keys: ReactionKey[],
): string {
	const options = prompt.options ?? [];

	if (options.length > 0) {
		const reactions = keys.map((entry) => entry.key);
		const reactPart =
			reactions.length === 0
				? ""
				: reactions.length <= 3
					? `React with ${reactions.join(" or ")}, or reply`
					: "React or reply";

		return reactPart ? `${reactPart} with a number.` : "Reply with a number.";
	}

	const fields = prompt.fields ?? [];

	if (fields.length === 1) {
		return "Reply with the answer, or “decline”.";
	}

	return "Reply with one “name: value” line per field, or “decline”.";
}

/** The answer a reaction gives, if it is one of the prompt's keys. */
export function answerFromReaction(
	pending: PendingInteraction,
	key: string,
): ChannelInteractionResponse | undefined {
	const normalized = normalizeEmoji(key);
	const keys = reactionKeys(pending.options);
	const exact = keys.find((entry) => normalizeEmoji(entry.key) === normalized);

	if (exact) {
		return { id: pending.id, optionId: exact.optionId };
	}

	const alias = ALLOW_ALIASES.some(
		(entry) => normalizeEmoji(entry) === normalized,
	)
		? "allow"
		: REJECT_ALIASES.some((entry) => normalizeEmoji(entry) === normalized)
			? "reject"
			: undefined;
	const option = alias
		? pending.options.find((entry) => entry.kind === alias)
		: undefined;

	return option ? { id: pending.id, optionId: option.id } : undefined;
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

/** Reaction keys compare without variation selectors (✅ and ✅️ are one key). */
export function normalizeEmoji(key: string): string {
	return key.replaceAll("️", "").trim();
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
