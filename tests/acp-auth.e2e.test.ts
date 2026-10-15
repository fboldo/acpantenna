#!/usr/bin/env bun

/// <reference types="bun" />

import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
	extractAuthMethodIds,
	isAuthRequiredError,
	StdioAcpClient,
} from "@acpantenna/acp";

const repoRoot = resolve(import.meta.dir, "..");
const dumbClientPath = join(
	repoRoot,
	"packages",
	"acp-dumb-client",
	"src",
	"main.ts",
);

test("rejects session/new until authenticated, then succeeds", async () => {
	const client = new StdioAcpClient({
		id: "auth-e2e",
		command: "bun",
		args: [dumbClientPath, "--auth-method", "api-key"],
		cwd: repoRoot,
	});

	try {
		await client.initialize();
		expect(extractAuthMethodIds(client.getAuthMethods())).toEqual(["api-key"]);

		let authRequired = false;
		try {
			await client.newSession({ cwd: repoRoot });
		} catch (error) {
			authRequired = isAuthRequiredError(error);
		}
		expect(authRequired).toBe(true);

		await client.authenticate("api-key");
		const session = await client.newSession({ cwd: repoRoot });
		expect(session.sessionId).toBeTruthy();
	} finally {
		await client.dispose();
	}
}, 15_000);
