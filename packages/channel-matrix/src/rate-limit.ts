/** A send the homeserver kept refusing for rate limits; try again after `retryAfterMs`. */
export class RateLimitedError extends Error {
	public constructor(public readonly retryAfterMs: number) {
		super(
			`The homeserver is rate-limiting the bot; retry in ${retryAfterMs}ms.`,
		);
		this.name = "RateLimitedError";
	}
}

export interface RateLimitOptions {
	/** Attempts in all, the first included. Default 5. */
	maxAttempts?: number;
	/** Longest single wait accepted here; a longer one is handed back. Default 30s. */
	maxWaitMs?: number;
	/** Wait when the server gives no `retry_after_ms`. Default 1s, doubled per attempt. */
	fallbackMs?: number;
	sleep?: (ms: number) => Promise<void>;
	/** Called before each wait, to report the limit (health, logs). */
	onLimited?: (waitMs: number) => void;
}

/**
 * `retry_after_ms` when `error` is an `M_LIMIT_EXCEEDED` (or a bare 429),
 * `null` when it carries no hint, `undefined` when it is not a rate limit.
 */
export function rateLimitDelay(error: unknown): number | null | undefined {
	if (!error || typeof error !== "object") {
		return undefined;
	}

	const candidate = error as {
		errcode?: string;
		httpStatus?: number;
		data?: { errcode?: string; retry_after_ms?: unknown };
		getRetryAfterMs?: () => number | null;
	};
	const errcode = candidate.errcode ?? candidate.data?.errcode;

	if (errcode !== "M_LIMIT_EXCEEDED" && candidate.httpStatus !== 429) {
		return undefined;
	}

	let hinted: number | null = null;

	try {
		hinted = candidate.getRetryAfterMs?.() ?? null;
	} catch {
		hinted = null;
	}

	const fromBody = candidate.data?.retry_after_ms;

	if (hinted === null && typeof fromBody === "number") {
		hinted = fromBody;
	}

	return hinted;
}

/**
 * Run `task`, waiting out `M_LIMIT_EXCEEDED` as the server asks. Gives up
 * with a `RateLimitedError` when the attempts run out or the server asks for
 * a wait longer than `maxWaitMs`, so the caller can hand the delay back to
 * the gateway rather than hold the room's queue.
 */
export async function withRateLimitRetry<T>(
	task: () => Promise<T>,
	options: RateLimitOptions = {},
): Promise<T> {
	const maxAttempts = options.maxAttempts ?? 5;
	const maxWaitMs = options.maxWaitMs ?? 30_000;
	const fallbackMs = options.fallbackMs ?? 1000;
	const sleep = options.sleep ?? ((ms) => Bun.sleep(ms));

	for (let attempt = 1; ; attempt += 1) {
		try {
			return await task();
		} catch (error) {
			const hinted = rateLimitDelay(error);

			if (hinted === undefined) {
				throw error;
			}

			const waitMs = hinted ?? fallbackMs * 2 ** (attempt - 1);

			if (attempt >= maxAttempts || waitMs > maxWaitMs) {
				throw new RateLimitedError(waitMs);
			}

			options.onLimited?.(waitMs);
			await sleep(waitMs);
		}
	}
}
