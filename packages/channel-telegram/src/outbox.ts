import type { ChannelToolCall } from "@acpantenna/channel";
import { cutMarkdown, MAX_MESSAGE_CHARS, markdownToHtml } from "./format.ts";
import {
	LiveMessage,
	type LiveMessageTransport,
	type MessageContent,
	type Schedule,
} from "./live-message.ts";
import { renderToolCalls } from "./tool-calls.ts";

/** Tool calls shown in one log message before the next starts a new one. */
const MAX_TOOL_LINES = 40;

export interface ChatOutboxOptions {
	transport: LiveMessageTransport;
	firstSendDelayMs: number;
	editIntervalMs: number;
	/** Longest message; Telegram's is 4096 characters. */
	maxChars?: number;
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
 * Everything the bot sends to one conversation, in order. A streamed reply
 * is one message edited as chunks arrive (continued in a new one past 4096
 * characters); the turn's tool calls are folded into one message edited in
 * place. Anything else (a push, a prompt, a file) first closes the open
 * message, so the chat reads top to bottom in the order things happened.
 */
export class ChatOutbox {
	private chain: Promise<unknown> = Promise.resolve();
	private open?: Block;
	/** Which log message each tool call is shown in, for status edits. */
	private readonly toolBlocks = new Map<string, ToolsBlock>();
	private readonly maxChars: number;

	public constructor(private readonly options: ChatOutboxOptions) {
		this.maxChars = options.maxChars ?? MAX_MESSAGE_CHARS;
	}

	/** Serialize network work for the conversation. */
	public run<T>(task: () => Promise<T>): Promise<T> {
		const next = this.chain.then(task);
		this.chain = next.catch(() => undefined);
		return next;
	}

	/** Append a streamed chunk of the turn's reply. */
	public appendReply(delta: string): void {
		let block = this.open;

		if (block?.kind !== "reply") {
			this.close();
			block = this.openReply();
		}

		block.text += delta;

		// A reply too long for one message continues in a new one, cut at a
		// paragraph (or line) where it can be, code blocks closed and reopened.
		while (block.text.length > this.maxChars) {
			const [head, rest] = cutMarkdown(block.text, this.maxChars);

			block.text = head;
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
			const previous = shown.toolCalls[index];
			shown.toolCalls[index] = {
				...previous,
				...toolCall,
				title: clip(toolCall.title ?? previous?.title),
			};
			shown.live.set(renderToolCalls(shown.toolCalls));
			return;
		}

		let block = this.open;

		if (block?.kind !== "tools" || block.toolCalls.length >= MAX_TOOL_LINES) {
			this.close();
			block = {
				kind: "tools",
				live: this.createLive(),
				toolCalls: [],
			};
			this.open = block;
		}

		block.toolCalls.push({ ...toolCall, title: clip(toolCall.title) });
		this.toolBlocks.set(toolCall.id, block);
		block.live.set(renderToolCalls(block.toolCalls));
	}

	/** Send something of its own, after whatever is open. */
	public post<T>(task: () => Promise<T>): Promise<T> {
		this.close();
		return this.run(task);
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

	private openReply(): ReplyBlock {
		const block: ReplyBlock = {
			kind: "reply",
			live: this.createLive(),
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

	private createLive(): LiveMessage {
		return new LiveMessage({
			transport: this.options.transport,
			run: (task) => this.run(task),
			firstSendDelayMs: this.options.firstSendDelayMs,
			editIntervalMs: this.options.editIntervalMs,
			onError: this.options.onError,
			schedule: this.options.schedule,
			now: this.options.now,
		});
	}
}

export function replyContent(text: string): MessageContent {
	return { html: markdownToHtml(text), text };
}

/** A tool's title, kept to a line: 40 of them must fit in one message. */
function clip(title: string | undefined): string | undefined {
	return title && title.length > 90 ? `${title.slice(0, 89)}…` : title;
}
