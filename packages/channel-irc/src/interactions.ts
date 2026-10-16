import type {
	ChannelElicitationField,
	ChannelInteractionOption,
	ChannelInteractionPrompt,
	ChannelInteractionResponse,
} from "@acpantenna/channel";

/** An interaction shown in a conversation, waiting for an answer. */
export interface PendingInteraction {
	id: string;
	kind: ChannelInteractionPrompt["kind"];
	options: ChannelInteractionOption[];
	fields: ChannelElicitationField[];
	/** Epoch ms after which the gateway has given up on it. */
	expiresAt: number;
}

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
 * The prompt as lines of text: the question, the numbered choices (or the
 * form's fields), and how to answer. IRC has no buttons; the answer is a
 * reply.
 */
export function renderInteraction(
	text: string,
	prompt: ChannelInteractionPrompt,
	address?: string,
): string[] {
	const options = prompt.options ?? [];
	const lines = [text];

	options.forEach((option, index) => {
		lines.push(`  ${index + 1}. ${option.label}`);
	});

	if (options.length === 0) {
		for (const field of prompt.fields ?? []) {
			lines.push(`  • ${describeField(field)}`);
		}
	}

	lines.push(answerHint(prompt, address));
	return lines;
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

/** `address` is how to start a reply in a channel ("bot: "), if one is needed. */
function answerHint(prompt: ChannelInteractionPrompt, address = ""): string {
	const options = prompt.options ?? [];

	if (options.length > 0) {
		const yesNo =
			options.some((option) => option.kind === "allow") &&
			options.some((option) => option.kind === "reject")
				? ", or yes / no"
				: "";

		return `Reply with a number${yesNo}.`;
	}

	const fields = prompt.fields ?? [];

	if (fields.length === 1) {
		return `Reply “${address}<answer>”, or “${address}decline”.`;
	}

	return `Reply “${address}name: value; name: value”, or “${address}decline”.`;
}

/**
 * The answer a reply gives: an option's number or label (or yes / no for a
 * permission), or form values. Anything else is not an answer and goes to
 * the agent as a normal message.
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

/** Whether a reply picks an option (a number, a label, yes / no), not a form. */
export function isOptionAnswer(
	pending: PendingInteraction,
	text: string,
): boolean {
	return (
		pending.options.length > 0 && answerFromText(pending, text) !== undefined
	);
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
		const prefixed = splitNamedPart(reply, fields);
		raw.set(onlyField.name, prefixed?.[1] ?? reply);
	} else {
		// One IRC line: `name: value; name: value`.
		for (const part of reply.split(/;\s*/)) {
			const named = splitNamedPart(part, fields);

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
function splitNamedPart(
	part: string,
	fields: ChannelElicitationField[],
): [string, string] | undefined {
	const separator = part.indexOf(":");

	if (separator <= 0) {
		return undefined;
	}

	const name = part.slice(0, separator).trim().toLowerCase();
	const field = fields.find(
		(entry) =>
			entry.name.toLowerCase() === name || entry.title?.toLowerCase() === name,
	);

	return field ? [field.name, part.slice(separator + 1).trim()] : undefined;
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

/** How an answer reads in the confirmation line: what was chosen. */
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
