import type { ChannelToolCall } from "@acpantenna/channel";
import { defaultSchedule, type Schedule } from "./flood.ts";
import { PlainTextFormatter, sanitize, toPlainLines } from "./format.ts";
import { splitLine, splitLines } from "./split.ts";

/** Where a conversation's lines go: the client, or a recorder in tests. */
export interface OutboxTransport {
	privmsg(target: string, text: string): void;
	notice(target: string, text: string): void;
	/** Bytes of text that fit in one line to `target`. */
	budget(command: "PRIVMSG" | "NOTICE", target: string): number;
}

export interface ConversationOutboxOptions {
	target: string;
	transport: OutboxTransport;
	/** Lines one reply sends before the rest waits for "more". 0: no limit. */
	maxLines: number;
	/** How to say "more" here: `more`, or `bot: more` in a channel. */
	moreCommand: () => string;
	/** Quiet before a streamed reply's unfinished line is sent anyway. */
	streamFlushMs?: number;
	/** Quiet before a batch of tool calls is sent as one line. */
	toolBatchMs?: number;
	schedule?: Schedule;
}

const STREAM_FLUSH_MS = 2_000;
const TOOL_BATCH_MS = 1_500;

const KIND_ICONS: Record<string, string> = {
	read: "📖",
	edit: "✏️",
	delete: "🗑️",
	move: "📦",
	search: "🔍",
	execute: "💻",
	think: "💭",
	fetch: "🌐",
	switch_mode: "🔀",
};

/** One tool call, short: what kind of tool, its title. */
export function toolCallLabel(toolCall: ChannelToolCall): string {
	const kind = KIND_ICONS[toolCall.kind ?? ""] ?? "🔧";
	return `${kind} ${sanitize(toolCall.title ?? toolCall.kind ?? "Tool call")}`;
}

/**
 * Everything the bot sends to one channel or nick, as IRC lines. IRC has no
 * edits, so a streamed reply goes out a finished line at a time; a reply
 * longer than `maxLines` sends its first lines and keeps the rest for
 * "more"; tool calls close together share one notice.
 */
export class ConversationOutbox {
	private readonly schedule: Schedule;
	private formatter = new PlainTextFormatter();
	/** The streamed reply's unfinished line. */
	private partial = "";
	/** Lines sent by the current reply, against `maxLines`. */
	private sentLines = 0;
	/** Lines over the limit, kept for "more". */
	private held: string[] = [];
	private hinted = false;
	private streaming = false;
	private cancelStreamTimer?: () => void;
	private tools: ChannelToolCall[] = [];
	private readonly shownTools = new Map<string, ChannelToolCall>();
	private cancelToolTimer?: () => void;

	public constructor(private readonly options: ConversationOutboxOptions) {
		this.schedule = options.schedule ?? defaultSchedule;
	}

	private get target(): string {
		return this.options.target;
	}

	/** A whole reply, sent as its lines, the first `maxLines` of them now. */
	public reply(text: string): void {
		this.flushTools();
		this.flushStream();
		this.startReply();
		this.emitLines(toPlainLines(text));
		this.hint();
	}

	/** A streamed chunk of the turn's reply. */
	public appendReply(delta: string): void {
		this.flushTools();

		// The turn's reply counts as one against maxLines, however many
		// pieces tool calls cut it into.
		this.streaming = true;

		this.partial += delta;

		const newline = this.partial.lastIndexOf("\n");

		if (newline !== -1) {
			const done = this.partial.slice(0, newline);
			this.partial = this.partial.slice(newline + 1);
			this.emitLines(this.formatStreamed(done.split("\n")));
		}

		this.cancelStreamTimer?.();
		this.cancelStreamTimer = this.schedule(() => {
			this.cancelStreamTimer = undefined;
			this.flushPartial();
			this.hint();
		}, this.options.streamFlushMs ?? STREAM_FLUSH_MS);
	}

	/** Lines that must all be read (a question and its choices): never held. */
	public lines(lines: string[]): void {
		this.flushTools();
		this.flushStream();
		const budget = this.options.transport.budget("PRIVMSG", this.target);

		for (const line of splitLines(lines.map(sanitize), budget)) {
			this.options.transport.privmsg(this.target, line);
		}
	}

	/** A short status line from the bot itself, as a NOTICE. */
	public notice(text: string): void {
		this.flushTools();
		this.flushStream();
		this.sendNotice(text);
	}

	/**
	 * A tool call. The first sight of each is batched with the ones that come
	 * right after it into one notice; of the updates, only a failure is told.
	 */
	public toolCall(toolCall: ChannelToolCall): void {
		const shown = this.shownTools.get(toolCall.id);

		if (shown) {
			const merged = { ...shown, ...toolCall };
			this.shownTools.set(toolCall.id, merged);

			if (toolCall.status === "failed" && shown.status !== "failed") {
				this.flushTools();
				this.flushStream();
				this.sendNotice(`❌ ${toolCallLabel(merged)} failed`);
			}

			return;
		}

		this.flushStream();
		this.shownTools.set(toolCall.id, toolCall);
		this.tools.push(toolCall);
		this.cancelToolTimer?.();
		this.cancelToolTimer = this.schedule(() => {
			this.cancelToolTimer = undefined;
			this.flushTools();
		}, this.options.toolBatchMs ?? TOOL_BATCH_MS);
	}

	/** The next page of a long reply; false when nothing is held. */
	public more(): boolean {
		if (this.held.length === 0) {
			return false;
		}

		const page = this.pageSize();
		const next = this.held.splice(0, page);

		for (const line of next) {
			this.options.transport.privmsg(this.target, line);
		}

		this.hinted = false;
		this.hint();
		return true;
	}

	public get hasMore(): boolean {
		return this.held.length > 0;
	}

	/**
	 * The turn is over (the user wrote again): send what is pending, and
	 * forget what was held for "more".
	 */
	public endTurn(): void {
		this.flushTools();
		this.flushStream();
		this.held = [];
		this.hinted = false;
		this.sentLines = 0;
		this.shownTools.clear();
	}

	private startReply(): void {
		this.sentLines = 0;
		this.held = [];
		this.hinted = false;
	}

	private formatStreamed(lines: string[]): string[] {
		const shown: string[] = [];

		for (const raw of lines) {
			const line = this.formatter.line(raw);

			if (line !== undefined) {
				shown.push(line);
			}
		}

		return shown;
	}

	private flushPartial(): void {
		if (this.partial !== "") {
			const rest = this.partial;
			this.partial = "";
			this.emitLines(this.formatStreamed([rest]));
		}
	}

	/** End the streamed reply, if one is open: its last line goes out. */
	private flushStream(): void {
		if (!this.streaming) {
			return;
		}

		this.cancelStreamTimer?.();
		this.cancelStreamTimer = undefined;
		this.flushPartial();
		this.streaming = false;
		this.formatter = new PlainTextFormatter();
		this.hint();
	}

	private emitLines(lines: string[]): void {
		const budget = this.options.transport.budget("PRIVMSG", this.target);

		for (const line of lines.flatMap((entry) => splitLine(entry, budget))) {
			if (this.held.length > 0 || this.sentLines >= this.pageSize()) {
				this.held.push(line);
				continue;
			}

			this.options.transport.privmsg(this.target, line);
			this.sentLines += 1;
		}
	}

	private pageSize(): number {
		return this.options.maxLines > 0
			? this.options.maxLines
			: Number.POSITIVE_INFINITY;
	}

	/** Tell, once per page, that there is more and how to see it. */
	private hint(): void {
		if (this.held.length === 0 || this.hinted) {
			return;
		}

		this.hinted = true;
		const count = this.held.length;
		const say = `say “${this.options.moreCommand()}”`;

		this.sendNotice(
			this.streaming
				? `… the reply goes on; ${say} to see more.`
				: `… ${count} more line${count === 1 ? "" : "s"}; ${say} to see ${count === 1 ? "it" : "them"}.`,
		);
	}

	private flushTools(): void {
		this.cancelToolTimer?.();
		this.cancelToolTimer = undefined;

		if (this.tools.length === 0) {
			return;
		}

		const labels = this.tools.map(toolCallLabel);
		this.tools = [];
		this.sendNotice(labels.join(" · "));
	}

	private sendNotice(text: string): void {
		const budget = this.options.transport.budget("NOTICE", this.target);

		for (const line of splitLine(sanitize(text), budget)) {
			this.options.transport.notice(this.target, line);
		}
	}
}
