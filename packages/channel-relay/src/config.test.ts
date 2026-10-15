import { expect, test } from "bun:test";
import { configProblems } from "./config.ts";

test("a relay channel needs a secure relay and web origin, unless on this machine", () => {
	expect(
		configProblems({
			relayUrl: "wss://relay.example",
			webOrigin: "https://app.example",
		}),
	).toEqual([]);
	expect(
		configProblems({
			relayUrl: "ws://127.0.0.1:8787",
			webOrigin: "http://localhost:5173",
		}),
	).toEqual([]);
	expect(
		configProblems({
			relayUrl: "ws://relay.example",
			webOrigin: "http://app.example",
		}),
	).toEqual([
		"relayUrl must use wss:// unless it is on this machine.",
		"webOrigin must use https:// unless it is on this machine.",
	]);
	expect(
		configProblems({
			relayUrl: "https://relay.example",
			webOrigin: "https://app.example/app",
			linkTtlSeconds: 0,
			keyStorage: "disk" as "file",
		}),
	).toEqual([
		"relayUrl must be a ws:// or wss:// URL.",
		"webOrigin is a scheme and host only, like https://app.example.",
		"linkTtlSeconds must be a positive whole number.",
		'keyStorage is "keychain" or "file".',
	]);
});
