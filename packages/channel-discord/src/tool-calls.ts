import type { ChannelToolCall } from "@acpantenna/channel";
import { truncate } from "./format.ts";

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

/** Longest title shown on a line; a log of many calls stays readable. */
const MAX_TITLE_CHARS = 200;

function statusIcon(status: ChannelToolCall["status"]): string {
	switch (status) {
		case "completed":
			return "✅";
		case "failed":
			return "❌";
		default:
			return "⏳";
	}
}

/**
 * One compact line: status, what kind of tool, its title. As Discord
 * "subtext" (`-# `), small and grey, so the log reads as an aside to the reply.
 */
export function toolCallLine(toolCall: ChannelToolCall): string {
	const kind = KIND_ICONS[toolCall.kind ?? ""] ?? "🔧";
	const title = truncate(
		toolCall.title ?? toolCall.kind ?? "Tool call",
		MAX_TITLE_CHARS,
	);
	return `-# ${statusIcon(toolCall.status)} ${kind} ${title}`;
}

/** A turn's tool calls as one message, one line each. */
export function renderToolCalls(toolCalls: ChannelToolCall[]): string {
	return toolCalls.map(toolCallLine).join("\n");
}
