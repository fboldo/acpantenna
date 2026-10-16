import { expect, test } from "bun:test";
import { SendQueue, TokenBucket } from "./flood.ts";
import { createFakeClock } from "./testing/fake-clock.ts";

test("a bucket gives a burst, then a token per interval", () => {
	let now = 0;
	const bucket = new TokenBucket(3, 1000, () => now);

	expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([0, 0, 0]);
	expect(bucket.take()).toBe(1000);
	now = 500;
	expect(bucket.take()).toBe(500);
	now = 1000;
	expect(bucket.take()).toBe(0);
	now = 60_000;
	// Refilled, but never past the burst.
	expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
		0, 0, 0, 1000,
	]);
});

test("lines past the burst wait their turn, in order", async () => {
	const clock = createFakeClock();
	const written: string[] = [];
	const queue = new SendQueue({
		write: (line) => written.push(line),
		burst: 2,
		intervalMs: 1000,
		schedule: clock.schedule,
		now: clock.now,
	});

	for (const line of ["a", "b", "c", "d"]) {
		queue.push(line);
	}

	expect(written).toEqual(["a", "b"]);
	queue.urgent("PONG");
	expect(written).toEqual(["a", "b", "PONG"]);

	await clock.advance(1000);
	expect(written).toEqual(["a", "b", "PONG", "c"]);
	await clock.advance(1000);
	expect(written).toEqual(["a", "b", "PONG", "c", "d"]);
	expect(queue.pending).toBe(0);
});

test("a cleared queue sends nothing more", async () => {
	const clock = createFakeClock();
	const written: string[] = [];
	const queue = new SendQueue({
		write: (line) => written.push(line),
		burst: 1,
		intervalMs: 1000,
		schedule: clock.schedule,
		now: clock.now,
	});

	queue.push("a");
	queue.push("b");
	queue.clear();
	await clock.advance(5000);
	expect(written).toEqual(["a"]);
});
