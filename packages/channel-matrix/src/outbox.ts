import type { ChannelToolCall } from "@acpantenna/channel";
import { formatMarkdown } from "./format.ts";
import {
	LiveMessage,
	type LiveMessageTransport,
	type MessageContent,
	type Schedule,
} from "./live-message.ts";
import type { MediaContent } from "./media.ts";
import { renderToolCalls } from "./tool-calls.ts";

/** Longest reply body kept in one event; Matrix events are capped at 64 KiB. */
export const MAX_REPLY_CHARS = 16_000;

export interface RoomOutboxOptions {
	transport: LiveMessageTransport;
	firstSendDelayMs: number;
	editIntervalMs: number;
	onError?: (error: unknown) => void;
	schedule?: Schedule;
	now?: () => number;
}

interface ReplyBlock {
	kind: "reply";
	live: LiveMessage;
	text: string;
}

interface ToolsBlock {
	kind: "tools";
	live: LiveMessage;
	toolCalls: ChannelToolCall[];
}

type Block = ReplyBlock | ToolsBlock;

/**
 * Everything the bot sends to one room, in order. A streamed reply is one
 * message edited as chunks arrive; the turn's tool calls are folded into a
 * notice edited in place. Anything else (a push, a prompt, a buffered reply)
 * first closes the open message, so the room reads top to bottom in the
 * order things happened.
 */
export class RoomOutbox {
	private chain: Promise<unknown> = Promise.resolve();
	private open?: Block;
	/** Which tools notice each tool call is shown in, for status edits. */
	private readonly toolBlocks = new Map<string, ToolsBlock>();

	public constructor(private readonly options: RoomOutboxOptions) {}

	/** Serialize network work for the room. */
	public run<T>(task: () => Promise<T>): Promise<T> {
		const next = this.chain.then(task);
		this.chain = next.catch(() => undefined);
		return next;
	}

	/** Append a streamed chunk of the turn's reply. */
	public appendReply(delta: string, txnId?: string): void {
		let block = this.open;

		if (block?.kind !== "reply") {
			this.close();
			block = this.openReply(txnId);
		}

		block.text += delta;

		// A reply too long for one event continues in a new one, split at a
		// paragraph (or line) where it can be.
		while (block.text.length > MAX_REPLY_CHARS) {
			const cut = splitPoint(block.text, MAX_REPLY_CHARS);
			const rest = block.text.slice(cut).replace(/^\n+/, "");

			block.text = block.text.slice(0, cut);
			block.live.set(replyContent(block.text));
			this.close();
			block = this.openReply();
			block.text = rest;
		}

		block.live.set(replyContent(block.text));
	}

	/** Show a tool call, or update the line of one already shown. */
	public toolCall(toolCall: ChannelToolCall): void {
		const shown = this.toolBlocks.get(toolCall.id);

		if (shown) {
			const index = shown.toolCalls.findIndex(
				(entry) => entry.id === toolCall.id,
			);
			shown.toolCalls[index] = { ...shown.toolCalls[index], ...toolCall };
			shown.live.set(renderToolCalls(shown.toolCalls));
			return;
		}

		let block = this.open;

		if (block?.kind !== "tools") {
			this.close();
			block = {
				kind: "tools",
				live: this.createLive(),
				toolCalls: [],
			};
			this.open = block;
		}

		block.toolCalls.push(toolCall);
		this.toolBlocks.set(toolCall.id, block);
		block.live.set(renderToolCalls(block.toolCalls));
	}

	/** Send a message of its own, after whatever is open. Resolves to its event id. */
	public send(
		content: MessageContent | MediaContent,
		txnId?: string,
	): Promise<string> {
		this.close();
		return this.run(() => this.options.transport.send(content, txnId));
	}

	/**
	 * The turn is over (the user wrote again): send what is pending and start
	 * the next reply in a new message.
	 */
	public async endTurn(): Promise<void> {
		this.close();
		await this.idle();
	}

	/** Wait for every queued send and edit. */
	public async idle(): Promise<void> {
		let current: Promise<unknown>;

		do {
			current = this.chain;
			await current;
		} while (current !== this.chain);
	}

	private openReply(txnId?: string): ReplyBlock {
		const block: ReplyBlock = {
			kind: "reply",
			live: this.createLive(txnId),
			text: "",
		};
		this.open = block;
		return block;
	}

	/** Flush the open message now, in order, and stop appending to it. */
	private close(): void {
		const block = this.open;

		if (!block) {
			return;
		}

		this.open = undefined;
		void block.live.flush();
	}

	private createLive(txnId?: string): LiveMessage {
		return new LiveMessage({
			transport: this.options.transport,
			run: (task) => this.run(task),
			firstSendDelayMs: this.options.firstSendDelayMs,
			editIntervalMs: this.options.editIntervalMs,
			txnId,
			onError: this.options.onError,
			schedule: this.options.schedule,
			now: this.options.now,
		});
	}
}

export function replyContent(text: string): MessageContent {
	return { msgtype: "m.text", ...formatMarkdown(text) };
}

function splitPoint(text: string, limit: number): number {
	const window = text.slice(0, limit);
	const paragraph = window.lastIndexOf("\n\n");

	if (paragraph > limit / 2) {
		return paragraph;
	}

	const line = window.lastIndexOf("\n");
	return line > limit / 2 ? line : limit;
}
