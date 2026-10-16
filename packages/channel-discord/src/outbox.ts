import type { ChannelToolCall } from "@acpantenna/channel";
import { MAX_MESSAGE_CHARS, splitFirst } from "./format.ts";
import {
	LiveMessage,
	type LiveMessageTransport,
	type MessageContent,
	type Schedule,
} from "./live-message.ts";
import { renderToolCalls } from "./tool-calls.ts";

export interface ChannelOutboxOptions {
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
 * Everything the bot sends to one Discord channel, in order. A streamed
 * reply is one message edited as chunks arrive, continued in a new one at
 * 2000 characters; the turn's tool calls are folded into one quiet message
 * edited in place. Anything else (a push, a prompt, a buffered reply) first
 * closes the open message, so the channel reads top to bottom in the order
 * things happened.
 */
export class ChannelOutbox {
	private chain: Promise<unknown> = Promise.resolve();
	private open?: Block;
	/** Which tools message each tool call is shown in, for status edits. */
	private readonly toolBlocks = new Map<string, ToolsBlock>();

	public constructor(private readonly options: ChannelOutboxOptions) {}

	/** Serialize network work for the channel. */
	public run<T>(task: () => Promise<T>): Promise<T> {
		const next = this.chain.then(task);
		this.chain = next.catch(() => undefined);
		return next;
	}

	/** Append a streamed chunk of the turn's reply. */
	public appendReply(delta: string, nonce?: string): void {
		let block = this.open;

		if (block?.kind !== "reply") {
			this.close();
			block = this.openReply(nonce);
		}

		block.text += delta;

		// A reply too long for one message continues in a new one, split at a
		// paragraph (or line) where it can be, code blocks closed and reopened.
		for (
			let split = splitFirst(block.text);
			split;
			split = splitFirst(block.text)
		) {
			block.text = split[0];
			block.live.set({ content: block.text });
			this.close();
			block = this.openReply();
			block.text = split[1];
		}

		if (block.text.trim()) {
			block.live.set({ content: block.text });
		}
	}

	/** Show a tool call, or update the line of one already shown. */
	public toolCall(toolCall: ChannelToolCall): void {
		const shown = this.toolBlocks.get(toolCall.id);

		if (shown) {
			const index = shown.toolCalls.findIndex(
				(entry) => entry.id === toolCall.id,
			);
			shown.toolCalls[index] = { ...shown.toolCalls[index], ...toolCall };
			shown.live.set(toolsContent(shown.toolCalls));
			return;
		}

		let block = this.open;

		// A log that would pass the limit goes on in a new message.
		if (
			block?.kind !== "tools" ||
			renderToolCalls([...block.toolCalls, toolCall]).length > MAX_MESSAGE_CHARS
		) {
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
		block.live.set(toolsContent(block.toolCalls));
	}

	/** Send a message of its own, after whatever is open. Resolves to its id. */
	public send(content: MessageContent, nonce?: string): Promise<string> {
		this.close();
		return this.run(() => this.options.transport.send(content, nonce));
	}

	/** Run a task of its own (an upload), after whatever is open. */
	public after<T>(task: () => Promise<T>): Promise<T> {
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

	private openReply(nonce?: string): ReplyBlock {
		const block: ReplyBlock = {
			kind: "reply",
			live: this.createLive(nonce),
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

	private createLive(nonce?: string): LiveMessage {
		return new LiveMessage({
			transport: this.options.transport,
			run: (task) => this.run(task),
			firstSendDelayMs: this.options.firstSendDelayMs,
			editIntervalMs: this.options.editIntervalMs,
			nonce,
			onError: this.options.onError,
			schedule: this.options.schedule,
			now: this.options.now,
		});
	}
}

function toolsContent(toolCalls: ChannelToolCall[]): MessageContent {
	return { content: renderToolCalls(toolCalls), quiet: true };
}
