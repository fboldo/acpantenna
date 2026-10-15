import { expect, test } from "bun:test";
import type {
	ChannelInboundEvent,
	ChannelRouteHandler,
} from "@acpantenna/channel";
import { createConsoleLogger } from "@acpantenna/channel";
import { createWebhookChannel } from "./index.ts";

test("turns webhook posts into channel events and records outbound messages", async () => {
	const events: ChannelInboundEvent[] = [];
	const routes: Array<{
		method: string;
		path: string;
		handler: ChannelRouteHandler;
	}> = [];
	const adapter = createWebhookChannel({ type: "webhook" });

	await adapter.start({
		channelId: "inbox",
		config: {},
		logger: createConsoleLogger("test"),
		emit: (event) => {
			events.push(event);
		},
	});

	adapter.registerRoutes?.({
		route(method, path, handler) {
			routes.push({ method, path, handler });
		},
	});

	const postRoute = routes.find(
		(route) => route.method === "POST" && route.path === "/",
	);

	expect(postRoute).toBeDefined();

	const response = await postRoute?.handler(
		new Request("http://acpantenna.local/", {
			method: "POST",
			body: JSON.stringify({
				text: "hello",
				senderId: "sender-1",
				conversationId: "thread-1",
			}),
		}),
	);

	expect(response?.status).toBe(200);
	expect(events[0]?.content.text).toBe("hello");

	await adapter.send({ conversationId: "thread-1", text: "reply" });

	const outboxRoute = routes.find(
		(route) => route.method === "GET" && route.path === "/outbox",
	);
	const outboxResponse = await outboxRoute?.handler(
		new Request("http://acpantenna.local/outbox"),
	);
	const outbox = (await outboxResponse?.json()) as {
		messages: Array<{ text?: string }>;
	};

	expect(outbox.messages[0]?.text).toBe("reply");
});
