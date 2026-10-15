#!/usr/bin/env bun

/// <reference types="bun" />

import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { createTextPrompt, StdioAcpClient } from "@acpantenna/acp";

const repoRoot = resolve(import.meta.dir, "..");
const dumbClientPath = join(
	repoRoot,
	"packages",
	"acp-dumb-client",
	"src",
	"main.ts",
);

test("returns the agent's stop reason from a prompt turn", async () => {
	const client = new StdioAcpClient({
		id: "prompt-e2e",
		command: "bun",
		args: [dumbClientPath, "--stop-reason", "refusal"],
		cwd: repoRoot,
	});

	try {
		await client.initialize();
		const session = await client.newSession({ cwd: repoRoot });
		const result = await client.prompt({
			sessionId: session.sessionId,
			prompt: createTextPrompt("hello"),
		});

		expect(result.stopReason).toBe("refusal");
	} finally {
		await client.dispose();
	}
}, 15_000);
