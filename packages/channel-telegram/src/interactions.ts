import type {
	ChannelElicitationField,
	ChannelInteractionOption,
	ChannelInteractionPrompt,
	ChannelInteractionResponse,
} from "@acpantenna/channel";
import { escapeHtml, markdownToHtml } from "./format.ts";
import type { InlineKeyboardMarkup } from "./types.ts";

/** An interaction shown in a chat, waiting for an answer. */
export interface PendingInteraction {
	id: string;
	/** What its buttons carry: short, since `callback_data` is 64 bytes at most. */
	token: string;
	kind: ChannelInteractionPrompt["kind"];
	options: ChannelInteractionOption[];
	fields: ChannelElicitationField[];
	/** The message the prompt was sent as, once it is sent. */
	messageId?: number;
	/** Epoch ms after which the gateway has given up on it. */
	expiresAt: number;
}

/** What a prompt shows, kept to edit the answer into it. */
export interface RenderedPrompt {
	html: string;
	text: string;
	keyboard?: InlineKeyboardMarkup;
}

const CALLBACK_PREFIX = "a";
const DECLINE = "d";
/** Room the prompt's question gets, so the message stays under 4096 with its options. */
const MAX_QUESTION_CHARS = 3_000;
const MAX_BUTTON_CHARS = 60;
const ALLOW_WORDS = ["yes", "y", "allow", "ok", "approve"];
const REJECT_WORDS = ["no", "n", "deny", "reject"];
const DECLINE_WORDS = ["decline", "skip"];

export function createPendingInteraction(
	prompt: ChannelInteractionPrompt,
	expiresAt: number,
	token: string = randomToken(),
): PendingInteraction {
	return {
		id: prompt.id,
		token,
		kind: prompt.kind,
		options: prompt.options ?? [],
		fields: prompt.fields ?? [],
		expiresAt,
	};
}

/** Eight base-36 characters: enough that a button from before a restart answers nothing new. */
export function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return [...bytes].map((byte) => (byte % 36).toString(36)).join("");
}

/** `a:<token>:<option number>`, or `a:<token>:d` to decline a form. */
export function callbackData(token: string, choice: number | "decline") {
	return `${CALLBACK_PREFIX}:${token}:${choice === "decline" ? DECLINE : choice}`;
}

export function parseCallbackData(
	data: string,
): { token: string; choice: number | "decline" } | undefined {
	const match = /^a:([a-z0-9]+):(\d+|d)$/.exec(data);

	if (!match) {
		return undefined;
	}

	return {
		token: match[1] ?? "",
		choice: match[2] === DECLINE ? "decline" : Number(match[2]),
	};
}

/**
 * The buttons under a prompt: one per option, a row each (two to a row when
 * the labels are short), and Decline under a form, which is answered by a
 * reply instead.
 */
export function promptKeyboard(
	pending: Pick<PendingInteraction, "token" | "kind" | "options" | "fields">,
): InlineKeyboardMarkup | undefined {
	const buttons = pending.options.map((option, index) => ({
		text: buttonLabel(option),
		callback_data: callbackData(pending.token, index),
	}));

	if (buttons.length > 0) {
		const short = buttons.every((button) => button.text.length <= 16);
		const rows: (typeof buttons)[] = [];

		for (let index = 0; index < buttons.length; index += short ? 2 : 1) {
			rows.push(buttons.slice(index, index + (short ? 2 : 1)));
		}

		return { inline_keyboard: rows };
	}

	if (pending.kind === "elicitation" && pending.fields.length > 0) {
		return {
			inline_keyboard: [
				[
					{
						text: "Decline",
						callback_data: callbackData(pending.token, "decline"),
					},
				],
			],
		};
	}

	return undefined;
}

function buttonLabel(option: ChannelInteractionOption): string {
	const icon =
		option.kind === "allow" ? "✅ " : option.kind === "reject" ? "❌ " : "";
	const label = `${icon}${option.label}`;

	return label.length > MAX_BUTTON_CHARS
		? `${label.slice(0, MAX_BUTTON_CHARS - 1)}…`
		: label;
}

/** The prompt as a message: the question, the fields of a form, how to answer. */
export function renderInteraction(
	text: string,
	pending: Pick<PendingInteraction, "token" | "kind" | "options" | "fields">,
): RenderedPrompt {
	const question =
		text.length > MAX_QUESTION_CHARS
			? `${text.slice(0, MAX_QUESTION_CHARS - 1)}…`
			: text;
	const lines: string[] = [];

	if (pending.options.length === 0) {
		for (const field of pending.fields) {
			lines.push(`• ${describeField(field)}`);
		}
	}

	const hint = answerHint(pending);
	const keyboard = promptKeyboard(pending);
	const html = [
		markdownToHtml(question),
		...lines.map(escapeHtml),
		...(hint ? [`<i>${escapeHtml(hint)}</i>`] : []),
	].join("\n");

	return {
		html,
		text: [question, ...lines, ...(hint ? [hint] : [])].join("\n"),
		...(keyboard ? { keyboard } : {}),
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
	pending: Pick<PendingInteraction, "options" | "fields">,
): string | undefined {
	if (pending.options.length > 0) {
		// The buttons say it.
		return undefined;
	}

	return pending.fields.length === 1
		? "Reply to this message with the answer, or tap Decline."
		: "Reply to this message with one “name: value” line per field, or tap Decline.";
}

/** The answer a button gives, if it is one of this prompt's. */
export function answerFromCallback(
	pending: PendingInteraction,
	data: string,
): ChannelInteractionResponse | undefined {
	const parsed = parseCallbackData(data);

	if (!parsed || parsed.token !== pending.token) {
		return undefined;
	}

	if (parsed.choice === "decline") {
		return pending.kind === "elicitation"
			? { id: pending.id, declined: true }
			: undefined;
	}

	const option = pending.options[parsed.choice];
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

/** The prompt, edited to show its answer (and without its buttons). */
export function answeredPrompt(
	shown: RenderedPrompt,
	chosen: string,
	by: string,
): { html: string; text: string } {
	return {
		html: `${shown.html}\n\n→ <b>${escapeHtml(chosen)}</b> (${escapeHtml(by)})`,
		text: `${shown.text}\n\n→ ${chosen} (${by})`,
	};
}
