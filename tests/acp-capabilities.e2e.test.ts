#!/usr/bin/env bun

/// <reference types="bun" />

import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { StdioAcpClient } from "@acpantenna/acp";

const repoRoot = resolve(import.meta.dir, "..");
const dumbClientPath = join(
	repoRoot,
	"packages",
	"acp-dumb-client",
	"src",
	"main.ts",
);

function createClient(extraArgs: string[]): StdioAcpClient {
	return new StdioAcpClient({
		id: "capabilities-e2e",
		command: "bun",
		args: [dumbClientPath, ...extraArgs],
		cwd: repoRoot,
	});
}

test("negotiates protocol version and caches a capability-less agent", async () => {
	const client = createClient([]);

	try {
		const result = await client.initialize();

		expect(result.protocolVersion).toBe(1);
		expect(client.getProtocolVersion()).toBe(1);
		expect(client.supportsLoadSession()).toBe(false);
		expect(client.supportsResumeSession()).toBe(false);
		expect(client.supportsForkSession()).toBe(false);
		expect(client.getAgentCapabilities()).toEqual({
			loadSession: false,
			resumeSession: false,
			forkSession: false,
			listSessions: false,
			closeSession: false,
			deleteSession: false,
			prompt: { image: false, audio: false, embeddedContext: false },
		});
		expect(client.getInitializeResult()?.agentInfo?.name).toBe(
			"acpantenna-dumb-client",
		);
	} finally {
		await client.dispose();
	}
}, 15_000);

test("caches advertised session capabilities from the handshake", async () => {
	const client = createClient([
		"--load-session",
		"--resume",
		"--list-sessions",
		"--close-sessions",
	]);

	try {
		await client.initialize();

		expect(client.supportsLoadSession()).toBe(true);
		expect(client.supportsResumeSession()).toBe(true);
		expect(client.getAgentCapabilities()).toMatchObject({
			loadSession: true,
			resumeSession: true,
			listSessions: true,
			closeSession: true,
		});
	} finally {
		await client.dispose();
	}
}, 15_000);
