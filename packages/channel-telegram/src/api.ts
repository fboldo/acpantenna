/** What the Bot API answers when a call fails. */
export class TelegramApiError extends Error {
	public override readonly name = "TelegramApiError";

	public constructor(
		public readonly method: string,
		/** `error_code`: the HTTP status, mostly. */
		public readonly errorCode: number,
		public readonly description: string,
		public readonly parameters: {
			retry_after?: number;
			migrate_to_chat_id?: number;
		} = {},
	) {
		super(`${method}: ${description}`);
	}

	/** `retry_after`, in ms, when this is a 429. */
	public get retryAfterMs(): number | undefined {
		const seconds = this.parameters.retry_after;
		return typeof seconds === "number" ? seconds * 1000 : undefined;
	}
}

/** One call's parameters. Blobs (a `Bun.file`, bytes) make it a multipart upload. */
export type ApiParams = Record<string, unknown>;

export interface FileParam {
	blob: Blob;
	name: string;
}

export interface TelegramApiOptions {
	token: string;
	apiUrl: string;
	fetch?: typeof fetch;
	/** Per-call timeout, beyond a long poll's own wait. Default 30s. */
	timeoutMs?: number;
}

/**
 * The Bot API over fetch: `POST /bot<token>/<method>`, JSON in, `{ ok,
 * result }` out. A call with a file goes as multipart, the other parameters
 * as form fields (objects JSON-encoded, as the API expects).
 */
export class TelegramApi {
	private readonly fetch: typeof fetch;

	public constructor(private readonly options: TelegramApiOptions) {
		this.fetch = options.fetch ?? fetch;
	}

	public async call<T>(
		method: string,
		params: ApiParams = {},
		init: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<T> {
		const timeout = AbortSignal.timeout(
			init.timeoutMs ?? this.options.timeoutMs ?? 30_000,
		);
		const signal = init.signal
			? AbortSignal.any([init.signal, timeout])
			: timeout;
		const hasFile = Object.values(params).some(isFileParam);
		const response = await this.fetch(this.url(method), {
			method: "POST",
			...(hasFile
				? { body: toFormData(params) }
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(dropUndefined(params)),
					}),
			signal,
		});
		const body = (await response.json().catch(() => undefined)) as
			| {
					ok?: boolean;
					result?: T;
					error_code?: number;
					description?: string;
					parameters?: TelegramApiError["parameters"];
			  }
			| undefined;

		if (body?.ok) {
			return body.result as T;
		}

		throw new TelegramApiError(
			method,
			body?.error_code ?? response.status,
			body?.description ?? `HTTP ${response.status}`,
			body?.parameters,
		);
	}

	private url(method: string): string {
		const base = this.options.apiUrl.replace(/\/+$/, "");
		return `${base}/bot${this.options.token}/${method}`;
	}
}

export function isFileParam(value: unknown): value is FileParam {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as FileParam).blob instanceof Blob &&
		typeof (value as FileParam).name === "string"
	);
}

function dropUndefined(params: ApiParams): ApiParams {
	return Object.fromEntries(
		Object.entries(params).filter(([, value]) => value !== undefined),
	);
}

export function toFormData(params: ApiParams): FormData {
	const form = new FormData();

	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) {
			continue;
		}

		if (isFileParam(value)) {
			form.append(key, value.blob, value.name);
		} else if (typeof value === "object" && value !== null) {
			form.append(key, JSON.stringify(value));
		} else {
			form.append(key, String(value));
		}
	}

	return form;
}

/** A short, human-readable reason for a Bot API failure, for logs and health. */
export function describeTelegramError(error: unknown, apiUrl: string): string {
	const host = hostOf(apiUrl);

	if (error instanceof TelegramApiError) {
		switch (error.errorCode) {
			case 401:
				return "Telegram rejected the bot token. Copy it again from @BotFather (/token) and update the channel.";
			case 409:
				return /webhook/i.test(error.description)
					? "The bot has a webhook set, so it can't poll for updates. Remove it (deleteWebhook), or use another bot."
					: "Another program is polling for this bot's updates; only one can at a time.";
			case 429:
				return "Telegram is rate-limiting the bot; retrying.";
			default:
				break;
		}

		if (error.errorCode >= 500) {
			return `${host} is having trouble (HTTP ${error.errorCode}); retrying.`;
		}

		return `Telegram refused ${error.method}: ${error.description}.`;
	}

	const message = error instanceof Error ? error.message : String(error);

	if (
		/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|Unable to connect|network|socket|timed out|TimeoutError/i.test(
			message,
		) ||
		(error instanceof Error && error.name === "TimeoutError")
	) {
		return `Can't reach ${host}; retrying.`;
	}

	return redactToken(message);
}

/** The bot token is in every request URL; never let one into a log line. */
export function redactToken(text: string): string {
	return text.replace(/\d{3,}:[A-Za-z0-9_-]{20,}/g, "<bot token>");
}

export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
