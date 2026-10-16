import { TelegramApiError } from "./api.ts";

/** A send Telegram kept refusing for rate limits; try again after `retryAfterMs`. */
export class RateLimitedError extends Error {
	public constructor(public readonly retryAfterMs: number) {
		super(`Telegram is rate-limiting the bot; retry in ${retryAfterMs}ms.`);
		this.name = "RateLimitedError";
	}
}

export interface RateLimitOptions {
	/** Attempts in all, the first included. Default 5. */
	maxAttempts?: number;
	/** Longest single wait accepted here; a longer one is handed back. Default 30s. */
	maxWaitMs?: number;
	/** Wait when Telegram gives no `retry_after`. Default 1s, doubled per attempt. */
	fallbackMs?: number;
	sleep?: (ms: number) => Promise<void>;
	/** Called before each wait, to report the limit (health, logs). */
	onLimited?: (waitMs: number) => void;
}

/**
 * `retry_after` (in ms) when `error` is a 429, `null` when it carries no
 * hint, `undefined` when it is not a rate limit.
 */
export function rateLimitDelay(error: unknown): number | null | undefined {
	if (!(error instanceof TelegramApiError) || error.errorCode !== 429) {
		return undefined;
	}

	return error.retryAfterMs ?? null;
}

/**
 * Run `task`, waiting out a 429 as long as Telegram's `retry_after` says.
 * Gives up with a `RateLimitedError` when the attempts run out or the wait is
 * longer than `maxWaitMs`, so the caller can hand the delay back to the
 * gateway rather than hold the chat's queue.
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

/** How many sends a chat takes in a window, before Telegram starts answering 429. */
export interface PaceLimit {
	limit: number;
	windowMs: number;
}

/** About one a second in a private chat, small bursts allowed. */
export const PRIVATE_PACE: PaceLimit = { limit: 3, windowMs: 3_000 };
/** Telegram's stated limit for a group: 20 messages a minute. */
export const GROUP_PACE: PaceLimit = { limit: 20, windowMs: 60_000 };

/**
 * Spaces one chat's sends and edits so they stay under Telegram's limits,
 * rather than running into them and waiting out a 429. A sliding window:
 * `reserve` books the next free slot and says how long to wait for it.
 */
export class SendPacer {
	private readonly slots: number[] = [];

	public constructor(
		private readonly pace: PaceLimit,
		private readonly now: () => number = Date.now,
	) {}

	/** The wait, in ms, before the next send may go; the slot is taken. */
	public reserve(): number {
		const now = this.now();

		while (
			this.slots.length > 0 &&
			(this.slots[0] ?? 0) <= now - this.pace.windowMs
		) {
			this.slots.shift();
		}

		const at =
			this.slots.length < this.pace.limit
				? Math.max(now, this.slots.at(-1) ?? now)
				: (this.slots[this.slots.length - this.pace.limit] ?? now) +
					this.pace.windowMs;

		this.slots.push(at);
		return at - now;
	}
}
