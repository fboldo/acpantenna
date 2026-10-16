import type { Schedule } from "../flood.ts";

/** Timers that move only when told to, for the flood and batching tests. */
export function createFakeClock() {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();

	const schedule: Schedule = (callback, ms) => {
		const id = nextId++;
		timers.set(id, { at: now + ms, callback });
		return () => {
			timers.delete(id);
		};
	};

	/** Let promise chains run. */
	const settle = async () => {
		for (let index = 0; index < 20; index += 1) {
			await Promise.resolve();
		}
	};

	return {
		schedule,
		now: () => now,
		settle,
		get pendingTimers() {
			return timers.size;
		},
		async advance(ms: number) {
			const until = now + ms;

			while (true) {
				await settle();
				const due = [...timers.entries()]
					.filter(([, timer]) => timer.at <= until)
					.sort((left, right) => left[1].at - right[1].at)[0];

				if (!due) {
					break;
				}

				timers.delete(due[0]);
				now = due[1].at;
				due[1].callback();
			}

			now = until;
			await settle();
		},
	};
}
