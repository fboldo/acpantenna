import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
	AcpClient,
	AcpPromptRequest,
	AcpSessionRequest,
} from "@acpantenna/acp";
import { ArgsError, parseArgs } from "./args.ts";
import {
	chooseConnections,
	ensureServer,
	type ListedConnection,
	listConnections,
} from "./connections.ts";
import {
	resolveConfigPath,
	serverPidPath,
	serverSocketPath,
	serversDir,
} from "./paths.ts";
import { removeDir } from "./remove-dir.testing.ts";
import { isAlive, startServer } from "./server.ts";
import { VERSION } from "./version.ts";

/** A working directory, absolute on every OS. */
const WORK = resolve("/work");

test("parses a command, its words, and options in either form", () => {
	expect(
		parseArgs([
			"connect",
			"claude",
			"--session-id",
			"abc",
			"--channel=matrix",
			"--fork",
			"-c",
			"cfg.ts",
		]),
	).toEqual({
		command: "connect",
		positionals: ["claude"],
		options: {
			sessionId: "abc",
			channel: "matrix",
			fork: true,
			config: "cfg.ts",
		},
	});
	expect(parseArgs(["--server", "127.0.0.1:0"])).toEqual({
		positionals: [],
		options: { server: "127.0.0.1:0" },
	});
	expect(() => parseArgs(["connect", "--session-id"])).toThrow(ArgsError);
	expect(() => parseArgs(["ls", "--nope"])).toThrow("Unknown option: --nope");
});

function listed(
	acpSessionId: string,
	conversationId = "room",
): ListedConnection {
	return {
		channelId: "matrix",
		sessionKey: `matrix:conversation:${conversationId}`,
		agentId: "claude",
		acpSessionId,
		conversationId,
		updatedAt: "2026-10-14T00:00:00Z",
		connection: true,
		configPath: "/c.ts",
	};
}

test("kill picks a connection by session id, a prefix only it has, or its conversation", () => {
	const connections = [listed("abc-1", "one"), listed("abd-2", "two")];

	expect(chooseConnections(connections, "abd-2", {})).toEqual([
		connections[1] as ListedConnection,
	]);
	expect(chooseConnections(connections, "abc", {})).toEqual([
		connections[0] as ListedConnection,
	]);
	expect(() => chooseConnections(connections, "ab", {})).toThrow(
		"starts more than one session id",
	);
	expect(() => chooseConnections(connections, "zzz", {})).toThrow(
		"No connection to session zzz",
	);
	expect(
		chooseConnections(connections, undefined, { conversation: "two" }),
	).toEqual([connections[1] as ListedConnection]);
	expect(chooseConnections(connections, undefined, { all: true })).toEqual(
		connections,
	);
	expect(() => chooseConnections(connections, undefined, {})).toThrow(
		"Say which connection to drop",
	);
});

test("the config is the one passed, else the project's, else the user's", async () => {
	const root = mkdtempSync(join(tmpdir(), "acpantenna-paths-"));
	const project = join(root, "project");
	const userDir = join(root, "user");

	mkdirSync(project);
	mkdirSync(userDir);

	try {
		const env = { ACPANTENNA_CONFIG_DIR: userDir };

		// None yet: where setup will write it, which reads as the built-ins.
		expect(await resolveConfigPath(undefined, { cwd: project, env })).toBe(
			join(userDir, "config.json"),
		);

		writeFileSync(join(userDir, "config.json"), "{}");
		expect(await resolveConfigPath(undefined, { cwd: project, env })).toBe(
			join(userDir, "config.json"),
		);

		writeFileSync(join(project, "acpantenna.config.json"), "{}");
		expect(await resolveConfigPath(undefined, { cwd: project, env })).toBe(
			join(project, "acpantenna.config.json"),
		);
		expect(await resolveConfigPath("other.ts", { cwd: project, env })).toBe(
			join(project, "other.ts"),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("one server socket per config, short enough for a unix socket", () => {
	const a = serverSocketPath("/state", "/home/me/a/acpantenna.config.ts");
	const b = serverSocketPath("/state", "/home/me/b/acpantenna.config.ts");

	expect(a).not.toBe(b);
	expect(dirname(a)).toBe(join("/state", "servers"));
	expect(basename(a)).toMatch(/^[0-9a-f]{16}\.sock$/);
});

test("the server connects, lists and disconnects over its socket, then goes idle", async () => {
	const root = mkdtempSync(join(tmpdir(), "acpantenna-server-"));
	const configPath = join(root, "acpantenna.config.json");
	const stateDir = join(root, "state");
	const agent = new FakeAgent();
	let idle = 0;

	writeFileSync(
		configPath,
		JSON.stringify({
			server: { host: "127.0.0.1", port: 0 },
			agents: { main: { command: "unused" } },
			channels: {
				// Off, so the config's only channel is the one connect picks.
				latch: false,
				chat: {
					type: "webhook",
					defaultConversation: "room-1",
					permissions: { inbound: { mode: "open" } },
				},
			},
			state: { driver: "memory" },
		}),
	);

	const server = await startServer({
		configPath,
		stateDir,
		acpClientFactory: () => agent,
		onIdle: () => {
			idle += 1;
		},
		logger: silentLogger,
	});
	const call = async (method: string, path: string, body?: unknown) => {
		const response = await fetch(`http://localhost${path}`, {
			unix: server.socketPath,
			method,
			...(body ? { body: JSON.stringify(body) } : {}),
		});

		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	};

	try {
		// The webhook channel has routes, so it listens on a port of its own.
		expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

		const connected = await call("POST", "/connections", {
			agent: "main",
			sessionId: "s-1",
			cwd: WORK,
		});

		expect(connected).toEqual({
			status: 200,
			body: expect.objectContaining({
				channelId: "chat",
				conversationId: "room-1",
				acpSessionId: "s-1",
				cwd: WORK,
			}),
		});
		expect(agent.resumed).toEqual([{ sessionId: "s-1", cwd: WORK }]);
		expect(await listConnections({ entry: "", stateDir })).toEqual([
			expect.objectContaining({ acpSessionId: "s-1", configPath }),
		]);

		const refused = await call("POST", "/connections", { agent: "nobody" });
		expect(refused.status).toBe(400);
		expect(refused.body.error).toContain('There is no agent "nobody"');
		// The failed connect left the live one, so the server is not idle.
		await Bun.sleep(150);
		expect(idle).toBe(0);

		expect(
			(await call("POST", "/disconnect", { sessionId: "s-1" })).body,
		).toMatchObject({ acpSessionId: "s-1" });
		await Bun.sleep(150);
		expect(idle).toBe(1);
		expect((await call("GET", "/nowhere")).status).toBe(404);
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

/** An agent that resumes any session and answers every prompt. */
class FakeAgent implements AcpClient {
	public readonly resumed: Array<{ sessionId: string; cwd: string }> = [];

	public async connect(): Promise<void> {}
	public async initialize() {
		return { protocolVersion: 1 };
	}
	public supportsResumeSession(): boolean {
		return true;
	}
	public async resumeSession(
		sessionId: string,
		request: AcpSessionRequest,
	): Promise<void> {
		this.resumed.push({ sessionId, cwd: request.cwd });
	}
	public async newSession() {
		return { sessionId: "new-1" };
	}
	public async prompt(_request: AcpPromptRequest) {
		return { stopReason: "end_turn" as const };
	}
	public async cancel(): Promise<void> {}
	public async closeSession(): Promise<void> {}
	public async authenticate(): Promise<void> {}
	public onSessionUpdate(): () => void {
		return () => undefined;
	}
	public async dispose(): Promise<void> {}
}

const silentLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

function serverConfig(root: string): string {
	const configPath = join(root, "acpantenna.config.json");

	writeFileSync(
		configPath,
		JSON.stringify({
			agents: { main: { command: "unused" } },
			channels: { chat: { type: "webhook" } },
			server: { host: "127.0.0.1", port: 0 },
			state: { driver: "memory" },
		}),
	);

	return configPath;
}

test("one server per config: a second is refused while the first lives, and a dead one's pid file is taken over", async () => {
	const root = mkdtempSync(join(tmpdir(), "acpantenna-lock-"));
	const configPath = serverConfig(root);
	const stateDir = join(root, "state");
	const options = { configPath, stateDir, logger: silentLogger };
	const first = await startServer(options);

	try {
		const pidPath = serverPidPath(first.socketPath);

		expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid));
		await expect(startServer(options)).rejects.toThrow(
			/already running|already a server|A server is already running/,
		);
		await first.stop();
		expect(existsSync(pidPath)).toBe(false);

		// A pid file left by a process that is gone.
		writeFileSync(pidPath, "2147483646");
		const second = await startServer(options);
		expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid));
		await second.stop();
	} finally {
		await first.stop().catch(() => undefined);
		await removeDir(serversDir(stateDir));
		await removeDir(root);
	}
});

test("a server of another version is replaced by connect's own, which reports this version", async () => {
	const root = mkdtempSync(join(tmpdir(), "acpantenna-version-"));
	const configPath = serverConfig(root);
	const stateDir = join(root, "state");
	let stopped = false;
	const old = await startServer({
		configPath,
		stateDir,
		version: "0.0.1",
		logger: silentLogger,
		onShutdown: () => {
			stopped = true;
			void old.stop();
		},
	});
	const said: string[] = [];

	try {
		const socketPath = await ensureServer(configPath, {
			entry: join(import.meta.dir, "main.ts"),
			stateDir,
			err: (line) => said.push(line),
		});
		const health = (await (
			await fetch("http://localhost/health", { unix: socketPath })
		).json()) as { version: string; pid: number };

		expect(stopped).toBe(true);
		expect(said).toEqual([
			"Replacing the acpantenna server: it runs 0.0.1, this is dev.",
		]);
		expect(health.version).toBe(VERSION);
		expect(health.pid).not.toBe(process.pid);

		await fetch("http://localhost/shutdown", {
			unix: socketPath,
			method: "POST",
		});
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && isAlive(health.pid)) {
			await Bun.sleep(50);
		}
		expect(isAlive(health.pid)).toBe(false);
	} finally {
		await old.stop().catch(() => undefined);
		await removeDir(serversDir(stateDir));
		await removeDir(root);
	}
}, 30_000);
