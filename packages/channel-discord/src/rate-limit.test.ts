import { expect, test } from "bun:test";
import { RateLimitedError, RateLimits, routeKey } from "./rate-limit.ts";
import { DiscordApiError, DiscordRest } from "./rest.ts";

const CHANNEL = "123456789012345678";
const OTHER = "223456789012345678";
const MESSAGE = "323456789012345678";

test("routes keep their major parameter and drop the rest", () => {
	expect(routeKey("post", `/channels/${CHANNEL}/messages`)).toBe(
		`POST /channels/${CHANNEL}/messages`,
	);
	expect(routeKey("PATCH", `/channels/${CHANNEL}/messages/${MESSAGE}`)).toBe(
		`PATCH /channels/${CHANNEL}/messages/:id`,
	);
	expect(routeKey("POST", `/interactions/${MESSAGE}/aW50ZXJh/callback`)).toBe(
		"POST /interactions/:id/:token/callback",
	);
	expect(routeKey("GET", "/users/@me")).toBe("GET /users/@me");
});

function headers(values: Record<string, string>): Headers {
	return new Headers(values);
}

test("a bucket with nothing left waits for its reset; another channel does not", () => {
	let now = 1_000;
	const limits = new RateLimits(() => now);
	const route = routeKey("POST", `/channels/${CHANNEL}/messages`);
	const other = routeKey("POST", `/channels/${OTHER}/messages`);

	expect(limits.delay(route)).toBe(0);
	limits.update(
		route,
		headers({
			"x-ratelimit-bucket": "abc",
			"x-ratelimit-remaining": "1",
			"x-ratelimit-reset-after": "2.5",
		}),
	);
	limits.update(
		other,
		headers({
			"x-ratelimit-bucket": "abc",
			"x-ratelimit-remaining": "5",
			"x-ratelimit-reset-after": "5",
		}),
	);
	// One left: it goes, and the next waits for the reset.
	expect(limits.delay(route)).toBe(0);
	expect(limits.delay(route)).toBe(2_500);
	// The same bucket for another channel is counted on its own.
	expect(limits.delay(other)).toBe(0);
	now += 2_500;
	expect(limits.delay(route)).toBe(0);
});

test("a global 429 holds every route", () => {
	const limits = new RateLimits(() => 0);

	expect(
		limits.limited("GET /a", headers({}), { retry_after: 1.2, global: true }),
	).toBe(1_200);
	expect(limits.delay("GET /b")).toBe(1_200);
});

interface Call {
	url: string;
	init: RequestInit;
}

function fakeDiscord(responses: Response[]) {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	let now = 0;
	const rest = new DiscordRest({
		token: "tok",
		baseUrl: "https://discord.test/api",
		now: () => now,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
		fetch: async (url, init) => {
			calls.push({ url, init });
			const response = responses.shift();

			if (!response) {
				throw new Error("no more responses");
			}

			return response;
		},
	});

	return { rest, calls, sleeps };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...extra },
	});
}

test("a 429 is waited out as asked, then the request goes again", async () => {
	const { rest, calls, sleeps } = fakeDiscord([
		json({ message: "You are being rate limited.", retry_after: 0.75 }, 429),
		json({ id: "m1" }),
	]);

	await expect(
		rest.request("POST", `/channels/${CHANNEL}/messages`, {
			json: { content: "hi" },
		}),
	).resolves.toEqual({ id: "m1" });
	expect(sleeps).toEqual([750]);
	expect(calls).toHaveLength(2);
	expect(calls[0]?.url).toBe(
		`https://discord.test/api/channels/${CHANNEL}/messages`,
	);
	expect(calls[0]?.init.headers).toMatchObject({
		authorization: "Bot tok",
		"content-type": "application/json",
	});
	expect(calls[0]?.init.body).toBe('{"content":"hi"}');
});

test("a wait longer than the channel will hold is handed back", async () => {
	const { rest } = fakeDiscord([json({ retry_after: 120 }, 429)]);

	const failure = await rest
		.request("POST", `/channels/${CHANNEL}/messages`)
		.catch((error: unknown) => error);

	expect(failure).toBeInstanceOf(RateLimitedError);
	expect((failure as RateLimitedError).retryAfterMs).toBe(120_000);
});

test("an exhausted bucket delays the next request instead of earning a 429", async () => {
	const { rest, sleeps } = fakeDiscord([
		json({ id: "m1" }, 200, {
			"x-ratelimit-bucket": "b",
			"x-ratelimit-remaining": "0",
			"x-ratelimit-reset-after": "1",
		}),
		json({ id: "m2" }),
	]);

	await rest.request("POST", `/channels/${CHANNEL}/messages`);
	await rest.request("POST", `/channels/${CHANNEL}/messages`);
	expect(sleeps).toEqual([1_000]);
});

test("an error carries Discord's status and code; an interaction callback has no bot token", async () => {
	const { rest, calls } = fakeDiscord([
		json({ code: 50013, message: "Missing Permissions" }, 403),
		new Response(null, { status: 204 }),
	]);

	const failure = await rest
		.request("POST", `/channels/${CHANNEL}/messages`)
		.catch((error: unknown) => error);

	expect(failure).toBeInstanceOf(DiscordApiError);
	expect(failure).toMatchObject({ status: 403, code: 50013 });

	await rest.request("POST", `/interactions/${MESSAGE}/tkn/callback`, {
		json: { type: 6 },
		unauthenticated: true,
	});
	expect(calls[1]?.init.headers).not.toHaveProperty("authorization");
});
