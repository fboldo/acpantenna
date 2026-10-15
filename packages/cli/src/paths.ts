import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	configHome,
	defaultUserConfigPath,
	discoverConfig,
	stateHome,
} from "@acpantenna/config";

export { configHome, stateHome };

type Env = Record<string, string | undefined>;

const USER_CONFIG_NAMES = ["config.ts", "config.json"];

/** The user's own config, when there is one. */
export function userConfigPath(env: Env = process.env): string | undefined {
	const dir = configHome(env);

	return USER_CONFIG_NAMES.map((name) => join(dir, name)).find((path) =>
		existsSync(path),
	);
}

/**
 * The config a command uses: the one passed, else the project's, else the
 * user's own (which need not exist).
 */
export async function resolveConfigPath(
	configPath: string | undefined,
	options: { cwd?: string; env?: Env } = {},
): Promise<string> {
	const cwd = options.cwd ?? process.cwd();

	if (configPath) {
		return resolve(cwd, configPath);
	}

	const env = options.env ?? process.env;

	// None yet: the user's own, which reads as the built-ins until there is.
	return (
		(await discoverConfig(cwd)) ??
		userConfigPath(env) ??
		defaultUserConfigPath(env)
	);
}

/**
 * The directory of the background servers, one per config: each listens on
 * `<hash of its config path>.sock`, and logs beside it.
 */
/**
 * A unix socket's path must fit in about 104 bytes (macOS; 108 on Linux,
 * and Windows' AF_UNIX the same). Kept under this, as Nx and VS Code do,
 * with room for the `<16 hex>.sock` name.
 */
const MAX_SOCKET_PATH = 100;
const SOCKET_NAME_LENGTH = "0123456789abcdef.sock".length + 1;

export function serversDir(stateDir: string): string {
	const dir = join(stateDir, "servers");

	if (Buffer.byteLength(dir) + SOCKET_NAME_LENGTH <= MAX_SOCKET_PATH) {
		return dir;
	}

	// A home directory too deep for a socket: a short one of its own in the
	// temp directory, the same for the same state directory.
	const id = new Bun.CryptoHasher("sha256")
		.update(resolve(stateDir))
		.digest("hex")
		.slice(0, 12);

	return join(tmpdir(), `acpantenna-${id}`);
}

export function serverSocketPath(stateDir: string, configPath: string): string {
	const hash = new Bun.CryptoHasher("sha256")
		.update(resolve(configPath))
		.digest("hex")
		.slice(0, 16);

	return join(serversDir(stateDir), `${hash}.sock`);
}

/** The pid file that makes a server the only one for its config. */
export function serverPidPath(socketPath: string): string {
	return socketPath.replace(/\.sock$/, ".pid");
}

export function serverLogPath(socketPath: string): string {
	return socketPath.replace(/\.sock$/, ".log");
}
