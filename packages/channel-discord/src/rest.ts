import { RateLimitedError, RateLimits, routeKey } from "./rate-limit.ts";

export const DISCORD_API = "https://discord.com/api/v10";
const USER_AGENT =
	"DiscordBot (https://github.com/fboldo/acpantenna, 0.0.0) acpantenna";

/** An error answer from the Discord API: HTTP status and Discord's JSON error code. */
export class DiscordApiError extends Error {
	public constructor(
		public readonly status: number,
		public readonly code: number | undefined,
		message: string,
	) {
		super(message);
		this.name = "DiscordApiError";
	}
}

export interface DiscordRestOptions {
	token: string;
	baseUrl?: string;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Attempts in all, the first included. Default 5. */
	maxAttempts?: number;
	/** Longest wait accepted here; a longer one is handed back. Default 30s. */
	maxWaitMs?: number;
	/** Called before each wait, to report the limit (health, logs). */
	onLimited?: (route: string, waitMs: number) => void;
}

export interface RequestBody {
	/** Sent as JSON. */
	json?: unknown;
	/** Sent as multipart, for uploads. */
	form?: () => FormData;
	/** Without the bot's token: interaction callbacks are authorized by their own. */
	unauthenticated?: boolean;
}

/**
 * Discord's REST API with the bot's token. Requests wait out rate limits the
 * way Discord describes: per route bucket from the `X-RateLimit-*` headers,
 * and a 429's `retry_after` (global or not). A wait longer than `maxWaitMs`,
 * or too many 429s in a row, is a `RateLimitedError` the caller can hand
 * back to the gateway rather than hold a channel's queue.
 */
export class DiscordRest {
	private readonly limits: RateLimits;
	private readonly baseUrl: string;
	private readonly fetch: NonNullable<DiscordRestOptions["fetch"]>;
	private readonly sleep: (ms: number) => Promise<void>;

	public constructor(private readonly options: DiscordRestOptions) {
		this.limits = new RateLimits(options.now);
		this.baseUrl = options.baseUrl ?? DISCORD_API;
		this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
		this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
	}

	public async request<T>(
		method: string,
		path: string,
		body: RequestBody = {},
	): Promise<T> {
		const route = routeKey(method, path);
		const maxAttempts = this.options.maxAttempts ?? 5;
		const maxWaitMs = this.options.maxWaitMs ?? 30_000;

		for (let attempt = 1; ; attempt += 1) {
			const waitMs = this.limits.delay(route);

			if (waitMs > 0) {
				if (waitMs > maxWaitMs) {
					throw new RateLimitedError(waitMs);
				}

				this.options.onLimited?.(route, waitMs);
				await this.sleep(waitMs);
				continue;
			}

			const response = await this.fetch(`${this.baseUrl}${path}`, {
				method,
				headers: {
					"user-agent": USER_AGENT,
					...(body.unauthenticated
						? {}
						: { authorization: `Bot ${this.options.token}` }),
					...(body.json === undefined
						? {}
						: { "content-type": "application/json" }),
				},
				body:
					body.form?.() ??
					(body.json === undefined ? undefined : JSON.stringify(body.json)),
				signal: AbortSignal.timeout(30_000),
			});

			this.limits.update(route, response.headers);

			if (response.status === 429) {
				const limited = (await response.json().catch(() => undefined)) as
					| { retry_after?: number; global?: boolean }
					| undefined;
				const retryMs = this.limits.limited(route, response.headers, limited);

				if (attempt >= maxAttempts || retryMs > maxWaitMs) {
					throw new RateLimitedError(retryMs);
				}

				continue;
			}

			if (response.status === 204) {
				return undefined as T;
			}

			const text = await response.text();
			const parsed = text ? safeJson(text) : undefined;

			if (!response.ok) {
				const error = (parsed ?? {}) as { code?: number; message?: string };
				throw new DiscordApiError(
					response.status,
					error.code,
					error.message ?? `HTTP ${response.status}`,
				);
			}

			return parsed as T;
		}
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
