import {
	type ChannelAdapter,
	type ChannelCapabilities,
	type ChannelContext,
	type ChannelOutboundMessage,
	type ChannelRouteRegistry,
	createChannelAdapter,
	createTextInboundEvent,
	defineChannel,
} from "@acpantenna/channel";

export interface WebhookChannelConfig {
	type: "webhook";
}

export interface WebhookPayload {
	id?: string;
	text?: string;
	conversationId?: string;
	conversationType?: "dm" | "group" | "room" | "thread" | "unknown";
	senderId?: string;
	senderName?: string;
	trusted?: boolean;
	/** Answer a pending interaction (a permission prompt or elicitation) instead of prompting. */
	interaction?: {
		id: string;
		/** Selected option id (permission prompts). */
		optionId?: string;
		/** Form values (elicitation prompts). */
		content?: Record<string, string | number | boolean | string[]>;
		/** The user declined/cancelled the interaction. */
		declined?: boolean;
	};
}

/**
 * Neither `buttons` nor `toolCalls`/`thoughts`: a webhook consumer gets plain
 * text, with interaction choices spelled out in it.
 */
const WEBHOOK_CAPABILITIES: ChannelCapabilities = {
	inbound: true,
	outbound: true,
	routes: true,
};

export function createWebhookChannel(
	_config: unknown,
): ChannelAdapter<unknown> {
	let context: ChannelContext<unknown> | undefined;
	const outbox: ChannelOutboundMessage[] = [];

	return createChannelAdapter({
		manifest: {
			type: "webhook",
			name: "Webhook",
			version: "0.0.0",
			capabilities: WEBHOOK_CAPABILITIES,
		},

		start(nextContext) {
			context = nextContext;
		},

		send(message) {
			const messageWithId = {
				...message,
				id: message.id ?? crypto.randomUUID(),
			};

			outbox.push(messageWithId);

			return {
				ok: true,
				messageId: messageWithId.id,
			};
		},

		health() {
			return {
				state: context ? "ready" : "starting",
				checkedAt: new Date().toISOString(),
			};
		},

		registerRoutes(registry: ChannelRouteRegistry) {
			const handler = async (request: Request) => {
				if (!context) {
					return Response.json(
						{ ok: false, error: "Channel is not started" },
						{ status: 503 },
					);
				}

				let payload: WebhookPayload;

				try {
					payload = (await request.json()) as WebhookPayload;
				} catch {
					return Response.json(
						{ ok: false, error: "Expected JSON payload" },
						{ status: 400 },
					);
				}

				if (!payload.text && !payload.interaction) {
					return Response.json(
						{ ok: false, error: "text or interaction is required" },
						{ status: 400 },
					);
				}

				const event = createTextInboundEvent({
					id: payload.id,
					text: payload.text ?? "",
					conversationId:
						payload.conversationId ?? payload.senderId ?? "default",
					conversationType: payload.conversationType,
					senderId: payload.senderId ?? "anonymous",
					senderName: payload.senderName,
					trusted: payload.trusted,
					raw: payload,
				});

				if (payload.interaction) {
					event.interaction = payload.interaction;
				}

				await context.emit(event);

				return Response.json({ ok: true, eventId: event.id });
			};

			registry.route("POST", "/", handler);
			registry.route("POST", "/events", handler);
			registry.route("GET", "/outbox", () =>
				Response.json({ ok: true, messages: outbox }),
			);
		},
	});
}

export const webhookChannel = defineChannel({
	type: "webhook",
	name: "Webhook",
	description:
		"Accepts JSON events at POST /channels/<id>/events and records replies at GET /channels/<id>/outbox. For local testing and simple integrations.",
	capabilities: WEBHOOK_CAPABILITIES,
	configSchema: { type: "object", properties: {} },
	create: createWebhookChannel,
});
