import { expect, test } from "bun:test";
import {
	RateLimitedError,
	rateLimitDelay,
	withRateLimitRetry,
} from "./rate-limit.ts";

const limited = (retryAfterMs?: number) =>
	Object.assign(new Error("Too Many Requests"), {
		errcode: "M_LIMIT_EXCEEDED",
		httpStatus: 429,
		data: { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: retryAfterMs },
	});

test("reads retry_after_ms from an M_LIMIT_EXCEEDED", () => {
	expect(rateLimitDelay(limited(1500))).toBe(1500);
	expect(rateLimitDelay(limited())).toBeNull();
	expect(rateLimitDelay(new Error("boom"))).toBeUndefined();
	expect(
		rateLimitDelay({ errcode: "M_LIMIT_EXCEEDED", getRetryAfterMs: () => 700 }),
	).toBe(700);
});

test("waits as long as the server asks, then retries", async () => {
	const waits: number[] = [];
	let calls = 0;

	const result = await withRateLimitRetry(
		async () => {
			calls += 1;

			if (calls < 3) {
				throw limited(250 * calls);
			}

			return "sent";
		},
		{ sleep: async (ms) => void waits.push(ms) },
	);

	expect(result).toBe("sent");
	expect(waits).toEqual([250, 500]);
});

test("backs off on its own when the server gives no hint", async () => {
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

test("hands back a wait too long to hold the room for", async () => {
	const failure = withRateLimitRetry(
		async () => {
			throw limited(120_000);
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
		throw Object.assign(new Error("Forbidden"), { errcode: "M_FORBIDDEN" });
	});

	await expect(failure).rejects.toThrow("Forbidden");
	expect(calls).toBe(1);
});
