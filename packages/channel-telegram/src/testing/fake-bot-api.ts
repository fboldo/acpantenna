import type { TelegramUpdate } from "../types.ts";

export interface ApiCall {
	method: string;
	params: Record<string, unknown>;
	/** Set for a multipart upload. */
	form?: FormData;
}

type Answer = (call: ApiCall) => unknown;

/**
 * The Bot API, in memory: a `fetch` that answers getMe, getUpdates (long
 * polling on a queue the test fills) and records every other call.
 */
export function createFakeBotApi(
	options: { answers?: Record<string, Answer> } = {},
) {
	const calls: ApiCall[] = [];
	const queue: TelegramUpdate[] = [];
	let wake: (() => void) | undefined;
	let nextUpdateId = 1;
	let nextMessageId = 100;

	const answers: Record<string, Answer> = {
		getMe: () => ({
			id: 999,
			is_bot: true,
			first_name: "Agent",
			username: "AgentBot",
		}),
		getWebhookInfo: () => ({ url: "" }),
		sendMessage: (call) => ({
			message_id: nextMessageId++,
			chat: { id: call.params.chat_id },
			text: call.params.text,
		}),
		sendDocument: () => ({ message_id: nextMessageId++ }),
		sendPhoto: () => ({ message_id: nextMessageId++ }),
		...options.answers,
	};

	const fetcher = (async (url: string, init: RequestInit) => {
		const method = url.split("/").at(-1) ?? "";
		const form = init.body instanceof FormData ? init.body : undefined;
		const params = form
			? Object.fromEntries(
					[...form.entries()].filter(([, value]) => typeof value === "string"),
				)
			: (JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
		const call: ApiCall = { method, params, ...(form ? { form } : {}) };

		if (method === "getUpdates") {
			const offset = typeof params.offset === "number" ? params.offset : 0;

			while (!queue.some((update) => update.update_id >= offset)) {
				await new Promise<void>((resolve, reject) => {
					wake = resolve;
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				});
			}

			return Response.json({
				ok: true,
				result: queue.filter((update) => update.update_id >= offset),
			});
		}

		calls.push(call);
		const answer = answers[method];

		try {
			const result = answer ? answer(call) : true;
			return Response.json({ ok: true, result });
		} catch (error) {
			const failure = error as {
				error_code?: number;
				description?: string;
				parameters?: unknown;
			};
			return Response.json(
				{ ok: false, ...failure },
				{ status: failure.error_code ?? 500 },
			);
		}
	}) as unknown as typeof fetch;

	return {
		fetch: fetcher,
		calls,
		/** Hand the bot an update, as Telegram would on its next poll. */
		push(update: Omit<TelegramUpdate, "update_id">): void {
			queue.push({ update_id: nextUpdateId++, ...update });
			wake?.();
		},
		callsTo(method: string): ApiCall[] {
			return calls.filter((call) => call.method === method);
		},
	};
}

/** Wait, in real time, until `check` holds (or fail after a second). */
export async function eventually(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (check()) {
			return;
		}

		await Bun.sleep(5);
	}

	throw new Error("The condition never held.");
}
