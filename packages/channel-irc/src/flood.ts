export type Schedule = (callback: () => void, ms: number) => () => void;

export const defaultSchedule: Schedule = (callback, ms) => {
	const timer = setTimeout(callback, ms);
	(timer as { unref?: () => void }).unref?.();
	return () => clearTimeout(timer);
};

/**
 * A token bucket: `burst` lines may go at once, then one more every
 * `intervalMs`. Servers disconnect a client for "Excess Flood" well before
 * any message is lost, so lines wait here instead.
 */
export class TokenBucket {
	private tokens: number;
	private updatedAt: number;

	public constructor(
		private readonly burst: number,
		private readonly intervalMs: number,
		private readonly now: () => number = Date.now,
	) {
		this.tokens = burst;
		this.updatedAt = now();
	}

	/** Takes a token if there is one; otherwise the ms until there will be. */
	public take(): number {
		this.refill();

		if (this.tokens >= 1) {
			this.tokens -= 1;
			return 0;
		}

		return Math.ceil((1 - this.tokens) * this.intervalMs);
	}

	private refill(): void {
		const now = this.now();
		const elapsed = now - this.updatedAt;

		this.updatedAt = now;
		this.tokens = Math.min(
			this.burst,
			this.tokens + elapsed / Math.max(1, this.intervalMs),
		);
	}
}

export interface SendQueueOptions {
	write: (line: string) => void;
	burst: number;
	intervalMs: number;
	schedule?: Schedule;
	now?: () => number;
}

/**
 * Lines for the server, written in order as the bucket allows. Urgent ones
 * (PONG, the registration) skip the bucket: a PONG held behind a long reply
 * would get the bot disconnected for a ping timeout.
 */
export class SendQueue {
	private readonly lines: string[] = [];
	private readonly bucket: TokenBucket;
	private readonly schedule: Schedule;
	private cancelTimer?: () => void;

	public constructor(private readonly options: SendQueueOptions) {
		this.schedule = options.schedule ?? defaultSchedule;
		this.bucket = new TokenBucket(
			options.burst,
			options.intervalMs,
			options.now,
		);
	}

	public get pending(): number {
		return this.lines.length;
	}

	public push(line: string): void {
		this.lines.push(line);
		this.drain();
	}

	public urgent(line: string): void {
		this.options.write(line);
	}

	/** Forget what has not gone out (the connection closed). */
	public clear(): void {
		this.lines.length = 0;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
	}

	private drain(): void {
		if (this.cancelTimer) {
			return;
		}

		while (this.lines.length > 0) {
			const wait = this.bucket.take();

			if (wait > 0) {
				this.cancelTimer = this.schedule(() => {
					this.cancelTimer = undefined;
					this.drain();
				}, wait);
				return;
			}

			const line = this.lines.shift();

			if (line !== undefined) {
				this.options.write(line);
			}
		}
	}
}
