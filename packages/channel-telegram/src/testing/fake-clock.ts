import type {
	LiveMessageTransport,
	MessageContent,
	Schedule,
} from "../live-message.ts";

/** Timers that move only when told to, for the edit-batching tests. */
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

	/** Let promise chains run (sends, edits, the chat's queue). */
	const settle = async () => {
		for (let index = 0; index < 20; index += 1) {
			await Promise.resolve();
		}
	};

	return {
		schedule,
		now: () => now,
		settle,
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

export interface RecordedCall {
	op: "send" | "edit";
	messageId: number;
	content: MessageContent;
	at: number;
}

/** A transport that records what would have gone to Telegram. */
export function createRecordingTransport(now: () => number) {
	const calls: RecordedCall[] = [];
	let sent = 0;

	const transport: LiveMessageTransport = {
		async send(content) {
			sent += 1;
			calls.push({ op: "send", messageId: sent, content, at: now() });
			return sent;
		},
		async edit(messageId, content) {
			calls.push({ op: "edit", messageId, content, at: now() });
		},
	};

	return { calls, transport };
}
