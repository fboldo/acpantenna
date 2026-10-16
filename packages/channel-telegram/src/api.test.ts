import { expect, test } from "bun:test";
import {
	describeTelegramError,
	redactToken,
	TelegramApi,
	TelegramApiError,
} from "./api.ts";

const TOKEN = "123456789:AAEabcdefghijklmnopqrstuvwxyz012345";

function fakeFetch(
	answer: (url: string, init: RequestInit) => unknown,
	status = 200,
) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return Response.json(answer(url, init), { status });
	}) as unknown as typeof fetch;

	return { calls, fetcher };
}

test("a call is a JSON POST to /bot<token>/<method>, undefined left out", async () => {
	const { calls, fetcher } = fakeFetch(() => ({ ok: true, result: { id: 1 } }));
	const api = new TelegramApi({
		token: TOKEN,
		apiUrl: "https://api.telegram.org/",
		fetch: fetcher,
	});

	expect(
		await api.call<{ id: number }>("getMe", { a: 1, b: undefined }),
	).toEqual({
		id: 1,
	});
	expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
	expect(calls[0]?.init.body).toBe('{"a":1}');
});

test("a file makes it multipart, other fields as form values", async () => {
	const { calls, fetcher } = fakeFetch(() => ({
		ok: true,
		result: { message_id: 5 },
	}));
	const api = new TelegramApi({
		token: TOKEN,
		apiUrl: "https://api.telegram.org",
		fetch: fetcher,
	});

	await api.call("sendDocument", {
		chat_id: -100,
		message_thread_id: 3,
		reply_markup: { inline_keyboard: [] },
		document: { blob: new Blob(["hello"]), name: "notes.txt" },
	});

	const form = calls[0]?.init.body as FormData;
	expect(form).toBeInstanceOf(FormData);
	expect(form.get("chat_id")).toBe("-100");
	expect(form.get("message_thread_id")).toBe("3");
	expect(form.get("reply_markup")).toBe('{"inline_keyboard":[]}');
	const file = form.get("document") as File;
	expect(file.name).toBe("notes.txt");
	expect(await file.text()).toBe("hello");
});

test("a refusal becomes a TelegramApiError with its parameters", async () => {
	const { fetcher } = fakeFetch(
		() => ({
			ok: false,
			error_code: 429,
			description: "Too Many Requests: retry after 7",
			parameters: { retry_after: 7 },
		}),
		429,
	);
	const api = new TelegramApi({
		token: TOKEN,
		apiUrl: "https://api.telegram.org",
		fetch: fetcher,
	});
	const failure = api.call("sendMessage", {});

	await expect(failure).rejects.toBeInstanceOf(TelegramApiError);
	await expect(failure).rejects.toMatchObject({
		errorCode: 429,
		retryAfterMs: 7000,
	});
});

test("errors read as reasons a person can act on, never with the token", () => {
	const api = "https://api.telegram.org";

	expect(
		describeTelegramError(
			new TelegramApiError("getMe", 401, "Unauthorized"),
			api,
		),
	).toBe(
		"Telegram rejected the bot token. Copy it again from @BotFather (/token) and update the channel.",
	);
	expect(
		describeTelegramError(
			new TelegramApiError(
				"getUpdates",
				409,
				"Conflict: terminated by other getUpdates request",
			),
			api,
		),
	).toBe(
		"Another program is polling for this bot's updates; only one can at a time.",
	);
	expect(describeTelegramError(new TypeError("fetch failed"), api)).toBe(
		"Can't reach api.telegram.org; retrying.",
	);
	expect(
		describeTelegramError(
			new TelegramApiError("sendMessage", 502, "Bad Gateway"),
			api,
		),
	).toBe("api.telegram.org is having trouble (HTTP 502); retrying.");
	expect(
		describeTelegramError(
			new TelegramApiError(
				"sendMessage",
				403,
				"Forbidden: bot was blocked by the user",
			),
			api,
		),
	).toBe(
		"Telegram refused sendMessage: Forbidden: bot was blocked by the user.",
	);
	expect(redactToken(`GET https://api.telegram.org/bot${TOKEN}/getMe`)).toBe(
		"GET https://api.telegram.org/bot<bot token>/getMe",
	);
});
