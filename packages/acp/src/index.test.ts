import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	AcpError,
	createTextPrompt,
	extractAuthMethodIds,
	extractTextFromSessionUpdate,
	isAuthRequiredError,
	negotiateProtocolVersion,
	parseAgentCapabilities,
	parseSessionUpdate,
} from "./index.ts";

test("creates baseline ACP text prompts", () => {
	expect(createTextPrompt("hello")).toEqual([{ type: "text", text: "hello" }]);
});

test("extracts text from ACP session updates", () => {
	expect(
		extractTextFromSessionUpdate({
			sessionId: "session-1",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: "world",
				},
			},
		}),
	).toBe("world");
});

test("detects the auth-required error code", () => {
	expect(isAuthRequiredError({ code: -32000 })).toBe(true);
	expect(isAuthRequiredError({ code: -32601 })).toBe(false);
	expect(isAuthRequiredError(new Error("nope"))).toBe(false);
	expect(isAuthRequiredError(null)).toBe(false);
});

test("extracts advertised auth method ids", () => {
	expect(
		extractAuthMethodIds([
			{ id: "api-key", name: "API key" },
			{ id: "oauth" },
			{ name: "missing-id" },
			"not-an-object",
		]),
	).toEqual(["api-key", "oauth"]);
	expect(extractAuthMethodIds([])).toEqual([]);
});

test("accepts a supported negotiated protocol version", () => {
	expect(negotiateProtocolVersion(1)).toBe(1);
});

test("rejects an unsupported or malformed protocol version", () => {
	expect(() => negotiateProtocolVersion(2)).toThrow(AcpError);
	expect(() => negotiateProtocolVersion("1")).toThrow(AcpError);
	expect(() => negotiateProtocolVersion(undefined)).toThrow(AcpError);
});

test("parses presence-based session capabilities ({} vs null) and prompt blocks", () => {
	const capabilities = parseAgentCapabilities({
		protocolVersion: 1,
		agentCapabilities: {
			loadSession: true,
			sessionCapabilities: {
				resume: {},
				list: null,
				close: {},
				delete: {},
			},
			promptCapabilities: {
				image: true,
				audio: false,
			},
		},
	});

	expect(capabilities).toEqual({
		loadSession: true,
		resumeSession: true,
		forkSession: false,
		listSessions: false,
		closeSession: true,
		deleteSession: true,
		prompt: {
			image: true,
			audio: false,
			embeddedContext: false,
		},
	});
});

test("defaults every capability to false when none are advertised", () => {
	const capabilities = parseAgentCapabilities({ protocolVersion: 1 });

	expect(capabilities).toEqual({
		loadSession: false,
		resumeSession: false,
		forkSession: false,
		listSessions: false,
		closeSession: false,
		deleteSession: false,
		prompt: {
			image: false,
			audio: false,
			embeddedContext: false,
		},
	});
});

test("keeps thoughts out of the reply text", () => {
	expect(
		extractTextFromSessionUpdate({
			sessionId: "session-1",
			update: {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "hmm" },
			},
		}),
	).toBeUndefined();
	expect(
		parseSessionUpdate({
			sessionId: "session-1",
			update: {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "hmm" },
			},
		}),
	).toEqual({ kind: "thought", text: "hmm" });
});

test("parses tool calls and their updates", () => {
	expect(
		parseSessionUpdate({
			sessionId: "s",
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "t1",
				title: "Read README.md",
				kind: "read",
				status: "pending",
				rawInput: { id: "x" },
			},
		}),
	).toEqual({
		kind: "toolCall",
		update: false,
		toolCall: {
			id: "t1",
			title: "Read README.md",
			kind: "read",
			status: "pending",
		},
	});
	expect(
		parseSessionUpdate({
			sessionId: "s",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "t1",
				status: "completed",
			},
		}),
	).toEqual({
		kind: "toolCall",
		update: true,
		toolCall: { id: "t1", status: "completed" },
	});
});

test("reads push hints from _meta on the chunk", () => {
	expect(
		parseSessionUpdate({
			sessionId: "s",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "done" },
				_meta: { "acpantenna/push": { final: true, id: "card-7" } },
			},
		}),
	).toEqual({ kind: "message", text: "done", final: true, pushId: "card-7" });
	expect(
		parseSessionUpdate({
			sessionId: "s",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "part" },
			},
		}),
	).toEqual({ kind: "message", text: "part", final: false });
	expect(
		parseSessionUpdate({
			sessionId: "s",
			update: { sessionUpdate: "plan", entries: [] },
		}),
	).toEqual({ kind: "other", sessionUpdate: "plan" });
});

// Shapes from ACP's ContentBlock schema (@agentclientprotocol/sdk
// schema/types.gen.d.ts: ImageContent, ResourceLink, EmbeddedResource).
const chunk = (content: unknown, meta?: unknown) => ({
	sessionId: "session-1",
	update: {
		sessionUpdate: "agent_message_chunk",
		content,
		...(meta ? { _meta: meta } : {}),
	},
});

/** An absolute path on every OS, with a space to be encoded. */
const SHOT = resolve("/tmp/my shots/screen.png");

test("a file:// resource link is an attachment read from this machine", () => {
	expect(
		parseSessionUpdate(
			chunk(
				{
					type: "resource_link",
					uri: pathToFileURL(SHOT).href,
					name: "screen.png",
					mimeType: "image/png",
					size: 48213,
				},
				{ "acpantenna/push": { final: true } },
			),
		),
	).toEqual({
		kind: "attachment",
		attachment: {
			name: "screen.png",
			mimeType: "image/png",
			size: 48213,
			// Decoded (%20 is a space), in this OS's form (D:\\tmp\\… on Windows).
			path: SHOT,
		},
		final: true,
	});
});

test("a link to anything but a local file is a markdown link", () => {
	expect(
		parseSessionUpdate(
			chunk({
				type: "resource_link",
				uri: "https://github.com/fboldo/antenna/pull/3",
				name: "pull/3",
				title: "The PR",
			}),
		),
	).toEqual({
		kind: "message",
		text: "[The PR](https://github.com/fboldo/antenna/pull/3)",
		final: false,
	});
});

test("an image block carries its bytes, and is named when it has no uri", () => {
	expect(
		parseSessionUpdate(
			chunk({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }),
		),
	).toEqual({
		kind: "attachment",
		attachment: {
			name: "image.png",
			mimeType: "image/png",
			data: "iVBORw0KGgo=",
		},
		final: false,
	});
});

test("an embedded resource is an attachment, blob or text", () => {
	expect(
		parseSessionUpdate(
			chunk({
				type: "resource",
				resource: {
					uri: "file:///home/me/report.pdf",
					mimeType: "application/pdf",
					blob: "JVBERi0=",
				},
			}),
		),
	).toMatchObject({
		kind: "attachment",
		attachment: {
			name: "report.pdf",
			mimeType: "application/pdf",
			data: "JVBERi0=",
		},
	});
	expect(
		parseSessionUpdate(
			chunk({
				type: "resource",
				resource: { uri: "file:///repo/notes.md", text: "# hi" },
			}),
		),
	).toMatchObject({
		kind: "attachment",
		attachment: { name: "notes.md", text: "# hi" },
	});
});

test("a block with nothing to send is not an attachment", () => {
	expect(
		parseSessionUpdate(chunk({ type: "image", mimeType: "image/png" })),
	).toEqual({
		kind: "other",
		sessionUpdate: "agent_message_chunk",
	});
	expect(
		parseSessionUpdate(chunk({ type: "resource", resource: { uri: "x" } })),
	).toEqual({
		kind: "other",
		sessionUpdate: "agent_message_chunk",
	});
});
