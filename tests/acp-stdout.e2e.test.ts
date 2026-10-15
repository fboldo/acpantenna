#!/usr/bin/env bun

/// <reference types="bun" />

import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { StdioAcpClient } from "@acpantenna/acp";

const repoRoot = resolve(import.meta.dir, "..");
const noisyAgentPath = join(repoRoot, "tests", "fixtures", "noisy-agent.ts");

test("times out instead of hanging when the agent never replies", async () => {
	// The SDK's ndjson parser logs and skips non-JSON stdout, so a misbehaving
	// agent leaves the request unanswered; the short-RPC timeout must fire.
	const client = new StdioAcpClient({
		id: "noisy-invalid",
		command: "bun",
		args: [noisyAgentPath, "invalid-json"],
		cwd: repoRoot,
		requestTimeoutMs: 2000,
	});

	try {
		await expect(client.initialize()).rejects.toThrow(/timed out/);
	} finally {
		await client.dispose();
	}
}, 15_000);

test("bounds an unterminated stdout frame at the configured limit", async () => {
	const client = new StdioAcpClient({
		id: "noisy-oversize",
		command: "bun",
		args: [noisyAgentPath, "oversize"],
		cwd: repoRoot,
		maxFrameBytes: 1000,
		requestTimeoutMs: 5000,
	});

	try {
		await expect(client.initialize()).rejects.toThrow();
	} finally {
		await client.dispose();
	}
}, 15_000);
