import type { MediaContent } from "./media.ts";

/** What a live message shows: the fields of an `m.room.message`. */
export interface MessageContent {
	msgtype: "m.text" | "m.notice";
	body: string;
	format?: "org.matrix.custom.html";
	formatted_body?: string;
}

export interface LiveMessageTransport {
	/** Send the first version (or a file, which is never edited); resolves to its event id. */
	send(content: MessageContent | MediaContent, txnId?: string): Promise<string>;
	/** Replace the event's content (an `m.replace` edit). */
	edit(eventId: string, content: MessageContent): Promise<void>;
}

export type Schedule = (callback: () => void, ms: number) => () => void;

export interface LiveMessageOptions {
	transport: LiveMessageTransport;
	/** Runs network work in order with the room's other sends. */
	run: <T>(task: () => Promise<T>) => Promise<T>;
	/** Wait before the first send, so a burst of chunks becomes one message. */
	firstSendDelayMs: number;
	/** Least time between two edits; homeservers rate-limit edits like messages. */
	editIntervalMs: number;
	/** Transaction id for the first send, so a retried send is not doubled. */
	txnId?: string;
	onError?: (error: unknown) => void;
	schedule?: Schedule;
	now?: () => number;
}

const MAX_FAILURES = 3;

export const defaultSchedule: Schedule = (callback, ms) => {
	const timer = setTimeout(callback, ms);
	(timer as { unref?: () => void }).unref?.();
	return () => clearTimeout(timer);
};

/**
 * One Matrix message whose content keeps changing (a streamed reply, a list
 * of tool calls). `set` records the latest content; it is sent once after
 * `firstSendDelayMs`, then edited at most every `editIntervalMs`, always with
 * the newest content, so many updates cost a few events. Updates made while a
 * send is held up (by a rate limit, say) fold into the next edit.
 */
export class LiveMessage {
	private desired?: MessageContent;
	private sent?: MessageContent;
	private eventIdValue?: string;
	private lastSentAt = 0;
	private cancelTimer?: () => void;
	private queued?: Promise<void>;
	private failures = 0;
	private readonly schedule: Schedule;
	private readonly now: () => number;

	public constructor(private readonly options: LiveMessageOptions) {
		this.schedule = options.schedule ?? defaultSchedule;
		this.now = options.now ?? Date.now;
	}

	public get eventId(): string | undefined {
		return this.eventIdValue;
	}

	public get content(): MessageContent | undefined {
		return this.desired;
	}

	public set(content: MessageContent): void {
		this.desired = content;
		this.arm();
	}

	/** Send what is pending now (in the room's order) and wait for it. */
	public flush(): Promise<void> {
		this.disarm();
		return this.push();
	}

	private arm(): void {
		if (
			this.cancelTimer ||
			this.queued ||
			sameContent(this.desired, this.sent)
		) {
			return;
		}

		const delay =
			this.eventIdValue === undefined
				? this.options.firstSendDelayMs
				: Math.max(
						0,
						this.lastSentAt + this.options.editIntervalMs - this.now(),
					);

		this.cancelTimer = this.schedule(() => {
			this.cancelTimer = undefined;
			void this.push();
		}, delay);
	}

	private disarm(): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
	}

	private push(): Promise<void> {
		if (this.queued) {
			return this.queued;
		}

		const queued = this.options
			.run(async () => {
				this.queued = undefined;
				const snapshot = this.desired;

				if (!snapshot || sameContent(snapshot, this.sent)) {
					return;
				}

				if (this.eventIdValue === undefined) {
					this.eventIdValue = await this.options.transport.send(
						snapshot,
						this.options.txnId,
					);
				} else {
					await this.options.transport.edit(this.eventIdValue, snapshot);
				}

				this.sent = snapshot;
				this.lastSentAt = this.now();
				this.failures = 0;
			})
			.catch((error) => {
				this.failures += 1;
				this.options.onError?.(error);

				// Rate limits are waited out below this; what still fails three
				// times (no longer in the room, say) is given up rather than retried
				// forever.
				if (this.failures >= MAX_FAILURES) {
					this.sent = this.desired;
				}
			})
			.finally(() => {
				if (this.queued === queued) {
					this.queued = undefined;
				}

				// Content that changed while the send was in flight goes out next.
				this.arm();
			});

		this.queued = queued;
		return queued;
	}
}

export function sameContent(
	left: MessageContent | undefined,
	right: MessageContent | undefined,
): boolean {
	return (
		left?.msgtype === right?.msgtype &&
		left?.body === right?.body &&
		left?.formatted_body === right?.formatted_body
	);
}

/** The `m.room.message` content that edits `eventId` to show `content`. */
export function editContent(
	eventId: string,
	content: MessageContent,
): Record<string, unknown> {
	return {
		msgtype: content.msgtype,
		body: `* ${content.body}`,
		...(content.formatted_body
			? {
					format: content.format,
					formatted_body: `* ${content.formatted_body}`,
				}
			: {}),
		"m.new_content": { ...content },
		"m.relates_to": { rel_type: "m.replace", event_id: eventId },
	};
}
