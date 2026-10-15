import type { ChannelToolCall } from "@acpantenna/channel";
import { escapeHtml } from "./format.ts";
import type { MessageContent } from "./live-message.ts";

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

/** One compact line: status, what kind of tool, its title. */
export function toolCallLine(toolCall: ChannelToolCall): string {
	const kind = KIND_ICONS[toolCall.kind ?? ""] ?? "🔧";
	return `${statusIcon(toolCall.status)} ${kind} ${toolCall.title ?? toolCall.kind ?? "Tool call"}`;
}

/** Inline `code` in a title kept as code; everything else escaped. */
function lineHtml(line: string): string {
	return escapeHtml(line).replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * A turn's tool calls as one quiet `m.notice`, one line each, so the room
 * shows a short running log instead of a message per call.
 */
export function renderToolCalls(toolCalls: ChannelToolCall[]): MessageContent {
	const lines = toolCalls.map(toolCallLine);

	return {
		msgtype: "m.notice",
		body: lines.join("\n"),
		format: "org.matrix.custom.html",
		formatted_body: lines.map(lineHtml).join("<br>"),
	};
}
