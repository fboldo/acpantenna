export interface CliOptions {
	config?: string;
	server?: string;
	json?: boolean;
	help?: boolean;
	sessionId?: string;
	channel?: string;
	conversation?: string;
	cwd?: string;
	fork?: boolean;
	all?: boolean;
}

export interface ParsedArgs {
	command?: string;
	/** Words after the command, e.g. the agent of `connect claude`. */
	positionals: string[];
	options: CliOptions;
}

type ValueOption =
	| "config"
	| "server"
	| "sessionId"
	| "channel"
	| "conversation"
	| "cwd";
type FlagOption = "json" | "help" | "fork" | "all";

const VALUE_OPTIONS: Record<string, ValueOption> = {
	"--config": "config",
	"-c": "config",
	"--server": "server",
	"--session-id": "sessionId",
	"--channel": "channel",
	"--conversation": "conversation",
	"--cwd": "cwd",
};

const FLAG_OPTIONS: Record<string, FlagOption> = {
	"--json": "json",
	"--help": "help",
	"-h": "help",
	"--fork": "fork",
	"--all": "all",
};

export class ArgsError extends Error {}

/** `--name value`, `--name=value` and bare flags; the first word is the command. */
export function parseArgs(argv: string[]): ParsedArgs {
	const options: CliOptions = {};
	const words: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = equals === -1 ? arg : arg.slice(0, equals);
		const valueOption = VALUE_OPTIONS[name];

		if (valueOption) {
			const value = equals === -1 ? argv[index + 1] : arg.slice(equals + 1);

			if (value === undefined || (equals === -1 && value.startsWith("-"))) {
				throw new ArgsError(`${name} needs a value.`);
			}

			options[valueOption] = value;
			index += equals === -1 ? 1 : 0;
			continue;
		}

		const flagOption = FLAG_OPTIONS[arg];

		if (flagOption) {
			options[flagOption] = true;
			continue;
		}

		if (arg.startsWith("-") && arg !== "-") {
			throw new ArgsError(`Unknown option: ${arg}`);
		}

		words.push(arg);
	}

	const [command, ...positionals] = words;

	return { ...(command ? { command } : {}), positionals, options };
}
