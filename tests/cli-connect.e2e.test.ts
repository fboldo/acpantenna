#!/usr/bin/env bun

/// <reference types="bun" />

import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { serversDir } from "../packages/cli/src/paths.ts";

const repoRoot = resolve(import.meta.dir, "..");
const cliPath = join(repoRoot, "packages", "cli", "src", "main.ts");
const dumbClientPath = join(
	repoRoot,
	"packages",
	"acp-dumb-client",
	"src",
	"main.ts",
);

async function cli(
	args: string[],
	options: { cwd: string; stateDir: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn({
		cmd: ["bun", cliPath, ...args],
		cwd: options.cwd,
		env: { ...process.env, ACPANTENNA_STATE_DIR: options.stateDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	return { code, stdout, stderr };
}

test("connect starts a server in the background; ls shows it; kill drops it and the server stops", async () => {
	mkdirSync(join(repoRoot, "out"), { recursive: true });
	const root = mkdtempSync(join(repoRoot, "out", "acpantenna-cli-"));
	const project = join(root, "project");
	const stateDir = join(root, "state");
	const configPath = join(root, "acpantenna.config.json");
	const run = (args: string[]) => cli(args, { cwd: project, stateDir });

	mkdirSync(project);
	await Bun.write(
		configPath,
		JSON.stringify({
			server: { host: "127.0.0.1", port: 0 },
			agents: {
				dumb: {
					command: "bun",
					args: [dumbClientPath, "--resume", "--echo-context"],
				},
			},
			channels: {
				// Off: connect picks the config's only channel, and never the real relay.
				latch: false,
				webhook: {
					type: "webhook",
					defaultConversation: "room-1",
					permissions: { inbound: { mode: "open" } },
				},
			},
			state: { driver: "sqlite", path: "state.sqlite" },
		}),
	);

	let serverPid: number | undefined;

	try {
		const connected = await run([
			"connect",
			"dumb",
			"--session-id",
			"s-123",
			"--config",
			configPath,
		]);

		expect(connected.stderr).toBe("");
		expect(connected.stdout).toContain(
			"Connected dumb session s-123 to webhook · room-1",
		);
		expect(connected.stdout).toContain(`directory      ${project}`);

		const [socket] = readdirSync(serversDir(stateDir)).filter((name) =>
			name.endsWith(".sock"),
		);
		const health = (await (
			await fetch("http://localhost/health", {
				unix: join(serversDir(stateDir), socket ?? ""),
			})
		).json()) as { pid: number; url: string };
		serverPid = health.pid;

		// The conversation now talks to the connected session, in its directory.
		await fetch(`${health.url}/channels/webhook/events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: "hi",
				senderId: "u1",
				conversationId: "room-1",
			}),
		});
		const outbox = (await (
			await fetch(`${health.url}/channels/webhook/outbox`)
		).json()) as { messages: Array<{ text?: string }> };
		expect(outbox.messages.map((message) => message.text)).toEqual([
			`[s-123 ${project}] dumb client: hi`,
		]);

		const listed = JSON.parse((await run(["ls", "--json"])).stdout);
		expect(listed).toEqual([
			expect.objectContaining({
				agentId: "dumb",
				acpSessionId: "s-123",
				channelId: "webhook",
				conversationId: "room-1",
				cwd: project,
				configPath,
			}),
		]);

		const refused = await run(["connect", "dumb", "--config", configPath]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("is already connected to session s-123");

		const killed = await run(["kill", "s-1"]);
		expect(killed.stdout).toContain(
			"Disconnected dumb session s-123 from webhook · room-1",
		);

		// Nothing left to serve: the server stops and takes its socket with it.
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && isAlive(serverPid)) {
			await Bun.sleep(50);
		}
		expect(isAlive(serverPid)).toBe(false);
		expect(existsSync(join(serversDir(stateDir), socket ?? ""))).toBe(false);
		expect((await run(["ls"])).stdout.trim()).toBe("No connections.");
	} finally {
		if (serverPid && isAlive(serverPid)) {
			process.kill(serverPid);
		}

		rmSync(serversDir(stateDir), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
