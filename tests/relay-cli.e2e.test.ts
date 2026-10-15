#!/usr/bin/env bun

/// <reference types="bun" />

import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { startDevRelay } from "@acpantenna/channel-relay/dev-relay";
import { serversDir } from "../packages/cli/src/paths.ts";
import { removeDir } from "../packages/cli/src/remove-dir.testing.ts";
import { RelayBrowser, until } from "./fixtures/relay-browser.ts";

const repoRoot = resolve(import.meta.dir, "..");
const cliPath = join(repoRoot, "packages", "cli", "src", "main.ts");
const dumbClientPath = join(
	repoRoot,
	"packages",
	"acp-dumb-client",
	"src",
	"main.ts",
);

test("connect prints a link, shows the words, and lets the browser in only after a yes; kill ends it", async () => {
	const relay = startDevRelay();
	mkdirSync(join(repoRoot, "out"), { recursive: true });
	const root = mkdtempSync(join(repoRoot, "out", "acpantenna-relay-cli-"));
	const project = join(root, "project");
	const stateDir = join(root, "state");
	const servers = trackServers(stateDir);
	const configPath = join(root, "acpantenna.config.json");
	const env = { ...process.env, ACPANTENNA_STATE_DIR: stateDir };
	const run = async (args: string[]) => {
		const child = Bun.spawn({
			cmd: ["bun", cliPath, ...args],
			cwd: project,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, stdout, stderr };
	};

	mkdirSync(project);
	await Bun.write(
		configPath,
		JSON.stringify({
			agents: {
				// Its own directory: an agent still exiting would hold the test's.
				dumb: {
					command: "bun",
					args: [dumbClientPath, "--load-session", "--echo-context"],
					cwd: repoRoot,
				},
			},
			channels: {
				// Off: connect picks the config's only channel, and never the real relay.
				latch: false,
				web: {
					type: "relay",
					relayUrl: relay.url,
					webOrigin: "https://app.example",
					keyStorage: "file",
				},
			},
			state: { driver: "sqlite", path: "state.sqlite" },
		}),
	);

	let browser: RelayBrowser | undefined;

	try {
		const connect = Bun.spawn({
			cmd: ["bun", cliPath, "connect", "dumb", "--config", configPath],
			cwd: project,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		let stderr = "";
		const decoder = new TextDecoder();
		void (async () => {
			for await (const chunk of connect.stderr) {
				stderr += decoder.decode(chunk);
			}
		})();
		const stdout = new Response(connect.stdout).text();

		await until(
			() => stderr.includes("Waiting for the browser"),
			30_000,
			"the link",
		);
		const link = /https:\/\/app\.example\/#\S+/.exec(stderr)?.[0];
		expect(link).toBeDefined();

		browser = await RelayBrowser.open(link ?? "", relay.url);
		await until(
			() => stderr.includes("The browser shows:"),
			10_000,
			"the words",
		);
		expect(stderr).toContain(`The browser shows: ${browser.words?.join(" ")}`);
		// Nothing for the browser until the user says yes.
		expect(browser.session?.state).toBe("pairing");

		connect.stdin.write("yes\n");
		await connect.stdin.end();
		await browser.confirmed;
		expect(await connect.exited).toBe(0);

		const out = await stdout;
		expect(out).toMatch(/Connected dumb session dumb-session-1 to web · \S+/);

		const sessions = await browser.rpc("session/list", {});
		expect(sessions.result).toEqual({
			sessions: [{ sessionId: "dumb-session-1", cwd: project }],
		});

		const listed = JSON.parse((await run(["ls", "--json"])).stdout);
		expect(listed).toEqual([
			expect.objectContaining({
				agentId: "dumb",
				channelId: "web",
				acpSessionId: "dumb-session-1",
				pairing: { state: "connected" },
			}),
		]);
		expect((await run(["ls"])).stdout).toContain("(connected)");

		const killed = await run(["kill", "dumb-session-1"]);
		expect(killed.stdout).toContain("Disconnected dumb session dumb-session-1");
		await until(() => browser?.closeEvent !== undefined);
		expect(browser.closeEvent).toMatchObject({ kind: "ended", byPeer: true });

		const revoked = await run(["revoke", "--config", configPath]);
		expect(revoked.stderr).toBe("");
		// The whole result, so a failure shows what revoke said instead.
		expect(revoked).toMatchObject({
			code: 0,
			stdout: expect.stringContaining(
				"Revoked web: its key is forgotten, no link it gave out works, and 0 connections were dropped.",
			),
		});
	} finally {
		browser?.close();
		await relay.stop();
		await cleanUp(root, stateDir, servers);
	}
}, 60_000);

test("connect ends without a connection when the words are not confirmed", async () => {
	const relay = startDevRelay();
	mkdirSync(join(repoRoot, "out"), { recursive: true });
	const root = mkdtempSync(join(repoRoot, "out", "acpantenna-relay-cli-"));
	const stateDir = join(root, "state");
	const servers = trackServers(stateDir);
	const configPath = join(root, "acpantenna.config.json");

	await Bun.write(
		configPath,
		JSON.stringify({
			agents: {
				dumb: { command: "bun", args: [dumbClientPath], cwd: repoRoot },
			},
			channels: {
				// Off: connect picks the config's only channel, and never the real relay.
				latch: false,
				web: {
					type: "relay",
					relayUrl: relay.url,
					webOrigin: "https://app.example",
					keyStorage: "file",
				},
			},
			state: { driver: "sqlite", path: "state.sqlite" },
		}),
	);

	let browser: RelayBrowser | undefined;

	try {
		const connect = Bun.spawn({
			cmd: ["bun", cliPath, "connect", "dumb", "--config", configPath],
			cwd: root,
			env: { ...process.env, ACPANTENNA_STATE_DIR: stateDir },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		let stderr = "";
		const decoder = new TextDecoder();
		void (async () => {
			for await (const chunk of connect.stderr) {
				stderr += decoder.decode(chunk);
			}
		})();

		await until(
			() => stderr.includes("Waiting for the browser"),
			30_000,
			"the link",
		);
		browser = await RelayBrowser.open(
			/https:\/\/app\.example\/#\S+/.exec(stderr)?.[0] ?? "",
			relay.url,
		);
		await until(
			() => stderr.includes("The browser shows:"),
			10_000,
			"the words",
		);
		connect.stdin.write("no\n");
		await connect.stdin.end();

		expect(await connect.exited).toBe(1);
		await until(() => stderr.includes("the words were not confirmed"));
		await until(() => browser?.closeEvent !== undefined);
		expect(browser.closeEvent).toMatchObject({ kind: "ended", byPeer: true });
	} finally {
		browser?.close();
		await relay.stop();
		await cleanUp(root, stateDir, servers);
	}
}, 60_000);

/**
 * Notes the pid of every background server started under `stateDir`, from
 * their pid files, for as long as the test runs: a server removes its file
 * just before it exits, so the file alone cannot say when it is gone.
 */
function trackServers(stateDir: string): { pids: Set<number>; stop(): void } {
	const dir = serversDir(stateDir);
	const pids = new Set<number>();
	const look = () => {
		if (!existsSync(dir)) {
			return;
		}

		for (const name of readdirSync(dir).filter((file) =>
			file.endsWith(".pid"),
		)) {
			try {
				const pid = Number(readFileSync(join(dir, name), "utf8").trim());

				if (Number.isInteger(pid) && pid > 0) {
					pids.add(pid);
				}
			} catch {
				// Removed as it was read.
			}
		}
	};
	const timer = setInterval(look, 20);

	return {
		pids,
		stop: () => {
			look();
			clearInterval(timer);
		},
	};
}

/**
 * Waits for the background servers the test started to exit, then removes
 * their directories. Until a server's process has exited it keeps its
 * database, its log and its working directory open, and Windows will not
 * delete those.
 */
async function cleanUp(
	root: string,
	stateDir: string,
	servers: ReturnType<typeof trackServers>,
): Promise<void> {
	servers.stop();

	if (servers.pids.size === 0) {
		throw new Error("No background server was seen; nothing to wait for.");
	}

	const deadline = Date.now() + 10_000;

	while (Date.now() < deadline && [...servers.pids].some(isAlive)) {
		await Bun.sleep(50);
	}

	for (const pid of servers.pids) {
		if (isAlive(pid)) {
			process.kill(pid);
		}
	}

	await removeDir(serversDir(stateDir));
	await removeDir(root);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
