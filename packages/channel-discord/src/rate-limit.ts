/** A request Discord kept refusing for rate limits; try again after `retryAfterMs`. */
export class RateLimitedError extends Error {
	public constructor(public readonly retryAfterMs: number) {
		super(`Discord is rate-limiting the bot; retry in ${retryAfterMs}ms.`);
		this.name = "RateLimitedError";
	}
}

/**
 * The route a request counts against, as Discord buckets them: the path with
 * IDs replaced, except the "major parameter" (a channel, server or webhook
 * ID) that each gets a bucket of its own. Message deletes have their own.
 */
export function routeKey(method: string, path: string): string {
	const bare = path.split("?")[0] ?? path;
	const parts = bare.split("/");
	const out: string[] = [];

	parts.forEach((part, index) => {
		const previous = parts[index - 1];

		if (/^\d{15,}$/.test(part)) {
			const major =
				previous === "channels" ||
				previous === "guilds" ||
				previous === "webhooks";
			out.push(major ? part : ":id");
			return;
		}

		// An interaction's token is a credential, not a route.
		if (previous !== undefined && /^\d{15,}$/.test(previous)) {
			const before = parts[index - 2];

			if (before === "interactions" || before === "webhooks") {
				out.push(":token");
				return;
			}
		}

		out.push(part);
	});

	const route = out.join("/");
	return method.toUpperCase() === "DELETE" && /\/messages\/:id$/.test(route)
		? `DELETE ${route}`
		: `${method.toUpperCase()} ${route}`;
}

/** The major parameter of a route key, to tell two channels' shared bucket apart. */
function majorOf(route: string): string {
	return /\/(?:channels|guilds|webhooks)\/(\d+)/.exec(route)?.[1] ?? "";
}

interface BucketState {
	remaining: number;
	resetAt: number;
}

/**
 * What Discord has said about its rate limits: which bucket each route is
 * in (`X-RateLimit-Bucket`), how many requests that bucket has left and when
 * it refills, and a global block after a global 429.
 */
export class RateLimits {
	private readonly bucketOfRoute = new Map<string, string>();
	private readonly buckets = new Map<string, BucketState>();
	private globalUntil = 0;

	public constructor(private readonly now: () => number = Date.now) {}

	private keyOf(route: string): string {
		const hash = this.bucketOfRoute.get(route);
		return hash ? `${hash}:${majorOf(route)}` : route;
	}

	/**
	 * How long to wait before sending on `route`, 0 to go now. Going counts
	 * against what is left, so requests made together do not all take the
	 * last one.
	 */
	public delay(route: string): number {
		const now = this.now();
		const global = Math.max(0, this.globalUntil - now);
		const bucket = this.buckets.get(this.keyOf(route));

		if (!bucket || bucket.resetAt <= now) {
			if (bucket) {
				this.buckets.delete(this.keyOf(route));
			}

			return global;
		}

		if (bucket.remaining > 0) {
			bucket.remaining -= 1;
			return global;
		}

		return Math.max(global, bucket.resetAt - now);
	}

	/** Record what a response's headers say about its bucket. */
	public update(route: string, headers: Headers): void {
		const hash = headers.get("x-ratelimit-bucket");
		const remaining = headers.get("x-ratelimit-remaining");
		const resetAfter = headers.get("x-ratelimit-reset-after");

		if (hash) {
			this.bucketOfRoute.set(route, hash);
		}

		if (remaining !== null && resetAfter !== null) {
			this.buckets.set(this.keyOf(route), {
				remaining: Number(remaining),
				resetAt: this.now() + Number(resetAfter) * 1000,
			});
		}
	}

	/**
	 * A 429: the wait it asks for, in ms. A global one blocks every route; a
	 * route's (or a shared resource's) empties that bucket until then.
	 */
	public limited(
		route: string,
		headers: Headers,
		body: { retry_after?: number; global?: boolean } | undefined,
	): number {
		const seconds =
			typeof body?.retry_after === "number"
				? body.retry_after
				: Number(headers.get("retry-after") ?? 1);
		const waitMs = Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000);
		const resetAt = this.now() + waitMs;

		if (body?.global || headers.get("x-ratelimit-global") === "true") {
			this.globalUntil = Math.max(this.globalUntil, resetAt);
		} else {
			this.update(route, headers);
			this.buckets.set(this.keyOf(route), { remaining: 0, resetAt });
		}

		return waitMs;
	}
}
