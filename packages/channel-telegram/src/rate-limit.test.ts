import { expect, test } from "bun:test";
import { TelegramApiError } from "./api.ts";
import {
	RateLimitedError,
	rateLimitDelay,
	SendPacer,
	withRateLimitRetry,
} from "./rate-limit.ts";

const limited = (retryAfter?: number) =>
	new TelegramApiError(
		"sendMessage",
		429,
		`Too Many Requests: retry after ${retryAfter}`,
		retryAfter === undefined ? {} : { retry_after: retryAfter },
	);

test("reads retry_after (seconds) from a 429, in ms", () => {
	expect(rateLimitDelay(limited(5))).toBe(5000);
	expect(rateLimitDelay(limited())).toBeNull();
	expect(rateLimitDelay(new Error("boom"))).toBeUndefined();
	expect(
		rateLimitDelay(new TelegramApiError("sendMessage", 400, "Bad Request")),
	).toBeUndefined();
});

test("waits as long as Telegram asks, then retries", async () => {
	const waits: number[] = [];
	let calls = 0;

	const result = await withRateLimitRetry(
		async () => {
			calls += 1;

			if (calls < 3) {
				throw limited(calls);
			}

			return "sent";
		},
		{ sleep: async (ms) => void waits.push(ms) },
	);

	expect(result).toBe("sent");
	expect(waits).toEqual([1000, 2000]);
});

test("backs off on its own when there is no hint", async () => {
	const waits: number[] = [];
	let calls = 0;

	await withRateLimitRetry(
		async () => {
			calls += 1;

			if (calls < 4) {
				throw limited();
			}
		},
		{ sleep: async (ms) => void waits.push(ms), fallbackMs: 100 },
	);

	expect(waits).toEqual([100, 200, 400]);
});

test("hands back a wait too long to hold the chat for", async () => {
	const failure = withRateLimitRetry(
		async () => {
			throw limited(120);
		},
		{ sleep: async () => undefined },
	);

	await expect(failure).rejects.toBeInstanceOf(RateLimitedError);
	await expect(failure).rejects.toMatchObject({ retryAfterMs: 120_000 });
});

test("other errors are not retried", async () => {
	let calls = 0;
	const failure = withRateLimitRetry(async () => {
		calls += 1;
		throw new TelegramApiError(
			"sendMessage",
			403,
			"Forbidden: bot was blocked",
		);
	});

	await expect(failure).rejects.toThrow("bot was blocked");
	expect(calls).toBe(1);
});

test("the pacer lets a burst through, then spaces sends to the window", () => {
	let now = 0;
	const pacer = new SendPacer({ limit: 3, windowMs: 3000 }, () => now);

	expect([pacer.reserve(), pacer.reserve(), pacer.reserve()]).toEqual([
		0, 0, 0,
	]);
	expect(pacer.reserve()).toBe(3000);
	expect(pacer.reserve()).toBe(3000);
	expect(pacer.reserve()).toBe(3000);
	expect(pacer.reserve()).toBe(6000);

	now = 10_000;
	expect(pacer.reserve()).toBe(0);
});

test("a group's twenty a minute", () => {
	let now = 0;
	const pacer = new SendPacer({ limit: 20, windowMs: 60_000 }, () => now);
	const waits: number[] = [];

	for (let index = 0; index < 21; index += 1) {
		waits.push(pacer.reserve());
		now += 1000;
	}

	expect(waits.slice(0, 20).every((wait) => wait === 0)).toBe(true);
	// The 21st, at 20s, waits for the first to leave the window at 60s.
	expect(waits[20]).toBe(40_000);
});
