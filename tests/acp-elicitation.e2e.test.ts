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

test("bridges an elicitation request over stdio and returns the answer", async () => {
	const client = new StdioAcpClient({
		id: "elicit-e2e",
		command: "bun",
		args: [dumbClientPath, "--elicit"],
		cwd: repoRoot,
	});

	const received: unknown[] = [];
	const chunks: string[] = [];

	// The handler must be registered before initialize() so the client advertises
	// the elicitation capability during the handshake.
	client.onElicitation?.((params) => {
		received.push(params);
		return { action: "accept", content: { name: "Ada" } };
	});
	client.onSessionUpdate((notification) => {
		const update = (notification as { update?: unknown }).update as {
			sessionUpdate?: string;
			content?: { type?: string; text?: string };
		};

		if (
			update?.sessionUpdate === "agent_message_chunk" &&
			typeof update.content?.text === "string"
		) {
			chunks.push(update.content.text);
		}
	});

	try {
		await client.initialize();
		const session = await client.newSession({ cwd: repoRoot });
		const result = await client.prompt({
			sessionId: session.sessionId,
			prompt: createTextPrompt("hello"),
		});

		expect(result.stopReason).toBe("end_turn");

		// The agent asked us for input mid-turn.
		expect(received).toHaveLength(1);
		const request = received[0] as { mode?: string; sessionId?: string };
		expect(request.mode).toBe("form");
		expect(request.sessionId).toBe(session.sessionId);

		// ...and echoed our accepted answer back through a session update.
		expect(chunks.join("")).toContain('[elicited accept: {"name":"Ada"}]');
	} finally {
		await client.dispose();
	}
}, 15_000);

test("declines an elicitation when no handler is registered", async () => {
	const client = new StdioAcpClient({
		id: "elicit-decline-e2e",
		command: "bun",
		args: [dumbClientPath, "--elicit"],
		cwd: repoRoot,
	});

	const chunks: string[] = [];

	client.onSessionUpdate((notification) => {
		const update = (notification as { update?: unknown }).update as {
			sessionUpdate?: string;
			content?: { type?: string; text?: string };
		};

		if (
			update?.sessionUpdate === "agent_message_chunk" &&
			typeof update.content?.text === "string"
		) {
			chunks.push(update.content.text);
		}
	});

	try {
		await client.initialize();
		const session = await client.newSession({ cwd: repoRoot });
		await client.prompt({
			sessionId: session.sessionId,
			prompt: createTextPrompt("hello"),
		});

		// With no handler, the client falls back to declining the request.
		expect(chunks.join("")).toContain("[elicited decline: null]");
	} finally {
		await client.dispose();
	}
}, 15_000);
