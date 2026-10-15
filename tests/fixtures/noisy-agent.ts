#!/usr/bin/env bun

/// <reference types="bun" />

// A deliberately misbehaving "ACP agent" used to exercise the stdio client's
// frame-limit and protocol-error handling. It writes non-protocol output to
// stdout and then stays alive so the client controls the lifecycle.

const mode = process.argv[2];

if (mode === "invalid-json") {
	process.stdout.write("this is not a json-rpc frame\n");
} else if (mode === "oversize") {
	// A long line with no newline: the client must bound its buffer instead of
	// growing it forever.
	process.stdout.write("x".repeat(5000));
}

await new Promise<void>(() => undefined);
