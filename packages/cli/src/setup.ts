import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { styleText } from "node:util";
import type { ChannelDefinition } from "@acpantenna/channel";
import {
	AGENT_PRESETS,
	type ConfigFieldSchema,
	isKeychainReference,
	keychain,
	keychainReference,
	normalizeConfig,
	type SecretStore,
} from "@acpantenna/config";
import * as clack from "@clack/prompts";
import type { CliOptions } from "./args.ts";
import { configHome } from "./paths.ts";

/** A choice in a select. */
export interface Choice<Value> {
	value: Value;
	label: string;
	hint?: string;
}

/** An answer is checked as it is typed: a message says what is wrong. */
export type Check = (value: string) => string | undefined;

/** How setup asks its questions: clack on a terminal, a script in tests. */
export interface Prompter {
	intro(title: string): void;
	outro(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	select<Value>(
		message: string,
		choices: Choice<Value>[],
		initial?: Value,
	): Promise<Value>;
	text(
		message: string,
		options?: { initial?: string; placeholder?: string; check?: Check },
	): Promise<string>;
	/** Masked; empty when nothing was typed. */
	password(message: string): Promise<string>;
	confirm(message: string, initial: boolean): Promise<boolean>;
}

/** The person backed out (Ctrl-C, Esc): nothing is written. */
export class SetupCancelled extends Error {
	public constructor() {
		super("Setup cancelled; nothing was written.");
	}
}

type Env = Record<string, string | undefined>;
type RawConfig = Record<string, unknown> & {
	agents?: Record<string, unknown>;
	channels?: Record<string, Record<string, unknown>>;
};

interface Field {
	name: string;
	schema: ConfigFieldSchema;
	required: boolean;
}

/**
 * `acpantenna setup`: add a channel to the user's own config (or change one
 * already there), asking for what its type needs, so `connect` can run
 * without a config of its own. What is already there is the starting
 * answer, so running it again edits rather than starts over.
 */
export async function setupCommand(
	options: CliOptions,
	prompter: Prompter,
	deps: {
		channels: ChannelDefinition[];
		/** Where secrets go; the OS keychain by default. */
		secrets?: SecretStore;
		env?: Env;
		findFreePort?: () => number;
	},
): Promise<string> {
	const env = deps.env ?? process.env;
	const configPath = options.config ?? join(configHome(env), "config.json");

	if (!configPath.endsWith(".json")) {
		throw new Error(
			`setup writes JSON; edit ${configPath} by hand, or pass --config <path>.json.`,
		);
	}

	const exists = existsSync(configPath);
	const config: RawConfig = exists
		? (JSON.parse(readFileSync(configPath, "utf8")) as RawConfig)
		: {};

	config.channels ??= {};

	const channels = config.channels;

	prompter.intro("acpantenna setup");
	prompter.info(`${exists ? "Editing" : "Creating"} ${configPath}`);

	const definition = await chooseChannelType(
		prompter,
		deps.channels,
		options.channel ? channels[options.channel]?.type : undefined,
	);
	const channelId =
		options.channel ??
		(await prompter.text("Name for this channel", {
			initial: definition.type,
			check: (value) =>
				/^[A-Za-z0-9._-]+$/.test(value)
					? undefined
					: "Letters, digits, dots, dashes and underscores only.",
		}));
	const existing = channels[channelId] ?? {};

	if (existing.type && existing.type !== definition.type) {
		throw new Error(
			`Channel "${channelId}" is a ${String(existing.type)} channel; choose another name.`,
		);
	}

	const channel: Record<string, unknown> = {
		...existing,
		type: definition.type,
	};
	const fields: Field[] = Object.entries(
		definition.configSchema.properties,
	).map(([name, schema]) => ({
		name,
		schema,
		required: definition.configSchema.required?.includes(name) ?? false,
	}));
	// What every setup needs comes first; the rest only when asked for.
	const essential = fields.filter(
		(field) => field.required || field.schema.secret,
	);
	const optional = fields.filter(
		(field) => !field.required && !field.schema.secret,
	);

	const secrets = deps.secrets ?? keychain;
	let keychainWorks = true;

	for (const field of essential) {
		let value = await askField(prompter, field, existing);

		// A new secret goes to the OS keychain; the config only names it.
		if (
			field.schema.secret &&
			typeof value === "string" &&
			!isKeychainReference(value) &&
			keychainWorks
		) {
			const name = `${channelId}.${field.name}`;

			try {
				await secrets.set(name, value);
				value = keychainReference(name);
			} catch (error) {
				keychainWorks = false;
				prompter.warn(
					`No keychain to keep secrets in here (${error instanceof Error ? error.message : String(error)}). They stay in the config file, readable only by you.`,
				);
			}
		}

		setField(channel, field.name, value);
	}

	if (
		optional.length > 0 &&
		(await prompter.confirm(
			`Adjust optional settings?\n${note(
				optional.map((field) => field.schema.title ?? field.name).join(", "),
				"choice",
			)}`,
			false,
		))
	) {
		for (const field of optional) {
			setField(channel, field.name, await askField(prompter, field, existing));
		}
	}

	// A channel that carries ACP to a remote client pairs on every connect:
	// it has no conversations to name, nor senders to allow.
	if (!definition.capabilities?.acp) {
		const conversation = await prompter.text(
			`Conversation \`connect\` uses when none is given ${dim("(a room or chat id; optional)")}`,
			{ initial: stringOr(existing.defaultConversation) },
		);

		setField(channel, "defaultConversation", conversation.trim() || undefined);

		const permissions = (channel.permissions ?? {}) as Record<string, unknown>;
		const inbound = (permissions.inbound ?? {}) as Record<string, unknown>;
		const currentAllow = Array.isArray(inbound.allow)
			? (inbound.allow as string[])
			: [];
		const allow = (
			await prompter.text(
				`Who may talk to the agent? ${dim("(sender ids, comma-separated)")}`,
				{ initial: currentAllow.join(", ") },
			)
		)
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);

		if (allow.length === 0) {
			prompter.warn(
				"Nobody is allowed yet: messages will be ignored until you add a sender id here.",
			);
		}

		channel.permissions = {
			...permissions,
			inbound: { ...inbound, mode: "allowlist", allow },
			// Agents ask before acting; the conversation answers.
			toolCalls: permissions.toolCalls ?? "ask",
		};
	}

	channels[channelId] = channel;

	// Presets need nothing else; a config of one's own keeps its agents.
	config.agents ??= Object.fromEntries(
		Object.keys(AGENT_PRESETS).map((id) => [id, { preset: id }]),
	);

	if (definition.capabilities?.routes && !config.server) {
		const port = (deps.findFreePort ?? findFreePort)();
		config.server = { host: "127.0.0.1", port };
		prompter.info(`Its HTTP routes will listen on 127.0.0.1:${port}.`);
	}

	// Refuse to write a config that would not load.
	normalizeConfig(config, { configPath, cwd: dirname(configPath) });

	mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
	// It may hold secrets: only its owner reads it, however it was created.
	chmodSync(configPath, 0o600);

	const flag =
		Object.keys(channels).length > 1 ? ` --channel ${channelId}` : "";

	prompter.info(
		[
			"Connect a session to it:",
			`  ${bold(`acpantenna connect claude --session-id <id>${flag}`)}   the one you are in`,
			`  ${bold(`acpantenna connect claude${flag}`)}                     a new one`,
		].join("\n"),
	);
	prompter.outro(`Saved ${channelId}.`);

	return configPath;
}

async function chooseChannelType(
	prompter: Prompter,
	definitions: ChannelDefinition[],
	current: unknown,
): Promise<ChannelDefinition> {
	const known = definitions.find((definition) => definition.type === current);

	if (known) {
		return known;
	}

	const type = await prompter.select(
		"Which kind of channel?",
		definitions.map((definition) => ({
			value: definition.type,
			label: definition.name,
			...(definition.description
				? { hint: firstSentence(definition.description) }
				: {}),
		})),
	);
	const chosen = definitions.find((definition) => definition.type === type);

	if (!chosen) {
		throw new Error(`No channel type "${type}".`);
	}

	return chosen;
}

/**
 * One field, asked the way its schema says: a yes/no, a choice, a masked
 * secret, or text checked as it is typed. Undefined leaves it out.
 */
async function askField(
	prompter: Prompter,
	field: Field,
	existing: Record<string, unknown>,
): Promise<unknown> {
	const { name, schema, required } = field;
	const current = existing[name];
	const label = schema.title ?? name;
	// The description on lines of its own, under the question, dimmed.
	const message = schema.description
		? `${label}\n${note(schema.description, "text")}`
		: label;
	const choiceMessage = schema.description
		? `${label}\n${note(schema.description, "choice")}`
		: label;

	if (schema.type === "boolean") {
		const value = await prompter.confirm(
			choiceMessage,
			typeof current === "boolean" ? current : schema.default === true,
		);

		// The channel applies its own default; only a change is written down.
		return current !== undefined || value !== schema.default
			? value
			: undefined;
	}

	if (schema.enum) {
		return await prompter.select(
			choiceMessage,
			schema.enum.map((value) => ({ value, label: String(value) })),
			current ?? schema.default,
		);
	}

	if (schema.secret) {
		const value = await prompter.password(
			current === undefined
				? message
				: `${message} ${dim("(empty keeps the current one)")}`,
		);

		return value || current;
	}

	const answer = (
		await prompter.text(message, {
			// A required field starts at its default; an optional one only shows it.
			...(current !== undefined
				? { initial: formatValue(current) }
				: required && schema.default !== undefined
					? { initial: formatValue(schema.default) }
					: {}),
			...(schema.default === undefined || required
				? {}
				: { placeholder: formatValue(schema.default) }),
			check: (value) => checkAnswer(value, field),
		})
	).trim();

	if (!answer) {
		// Required with a default: the default, written down. Optional: left out.
		return required ? schema.default : undefined;
	}

	return parseAnswer(answer, schema);
}

function checkAnswer(value: string, field: Field): string | undefined {
	const label = field.schema.title ?? field.name;

	if (!value.trim()) {
		return field.required && field.schema.default === undefined
			? `${label} is required.`
			: undefined;
	}

	return parseAnswer(value.trim(), field.schema) === undefined
		? `${label} must be ${field.schema.type === "integer" ? "a whole number" : `a ${field.schema.type}`}.`
		: undefined;
}

export function parseAnswer(
	answer: string,
	schema: ConfigFieldSchema,
): unknown {
	switch (schema.type) {
		case "boolean":
			return /^(y|yes|true|1)$/i.test(answer)
				? true
				: /^(n|no|false|0)$/i.test(answer)
					? false
					: undefined;
		case "number":
		case "integer": {
			const number = Number(answer);
			return Number.isFinite(number) &&
				(schema.type === "number" || Number.isInteger(number))
				? number
				: undefined;
		}
		case "array":
			return answer
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean);
		default:
			return schema.enum && !schema.enum.includes(answer) ? undefined : answer;
	}
}

function setField(
	target: Record<string, unknown>,
	name: string,
	value: unknown,
): void {
	if (value === undefined) {
		delete target[name];
	} else {
		target[name] = value;
	}
}

function formatValue(value: unknown): string {
	return Array.isArray(value) ? value.join(", ") : String(value);
}

function stringOr(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Text under a question: dimmed and wrapped. Beside a text or password
 * question clack draws no guide line on a message's later lines, so it is
 * drawn here; a choice draws its own.
 */
function note(text: string, kind: "text" | "choice"): string {
	return wrap(text, 74)
		.split("\n")
		.map((line) => (kind === "text" ? `${dim("│")}  ${dim(line)}` : dim(line)))
		.join("\n");
}

/** Words in lines of at most `width` characters. */
function wrap(text: string, width: number): string {
	const lines: string[] = [];
	let line = "";

	for (const word of text.split(/\s+/)) {
		if (line && line.length + word.length + 1 > width) {
			lines.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}

	return [...lines, line].join("\n");
}

function firstSentence(text: string): string {
	return text.split(/(?<=\.)\s/)[0] ?? text;
}

function dim(text: string): string {
	return styleText("dim", text);
}

function bold(text: string): string {
	return styleText("bold", text);
}

function findFreePort(): number {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port ?? 0;

	probe.stop(true);

	return port;
}

/** Questions with @clack/prompts. Ctrl-C or Esc cancels without writing. */
export function clackPrompter(): Prompter {
	const answered = <Value>(value: Value): Exclude<Value, symbol> => {
		if (clack.isCancel(value)) {
			clack.cancel("Nothing was written.");
			throw new SetupCancelled();
		}

		return value as Exclude<Value, symbol>;
	};

	return {
		intro: (title) => clack.intro(styleText("inverse", ` ${title} `)),
		outro: (message) => clack.outro(message),
		info: (message) => clack.log.info(message),
		warn: (message) => clack.log.warn(message),
		select: async <Value>(
			message: string,
			choices: Choice<Value>[],
			initial?: Value,
		) =>
			answered(
				await clack.select<Value>({
					message,
					options: choices as Parameters<
						typeof clack.select<Value>
					>[0]["options"],
					...(initial === undefined ? {} : { initialValue: initial }),
				}),
			),
		text: async (message, options = {}) =>
			answered(
				await clack.text({
					message,
					...(options.initial === undefined
						? {}
						: { initialValue: options.initial }),
					...(options.placeholder === undefined
						? {}
						: { placeholder: options.placeholder }),
					...(options.check
						? { validate: (value) => options.check?.(value ?? "") }
						: {}),
				}),
			) ?? "",
		password: async (message) =>
			answered(await clack.password({ message })) ?? "",
		confirm: async (message, initial) =>
			answered(await clack.confirm({ message, initialValue: initial })),
	};
}
