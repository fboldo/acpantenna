import {
	type Attributes,
	type Span,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";

export const SERVICE_NAME = "acpantenna";

/**
 * Stable span names. Later phases attach attributes to these rather than
 * renaming them, so dashboards built early keep working.
 */
export const SPAN_NAMES = {
	initialize: "acp.initialize",
	sessionNew: "acp.session.new",
	sessionLoad: "acp.session.load",
	sessionResume: "acp.session.resume",
	promptTurn: "acp.prompt.turn",
	deliverySend: "delivery.send",
} as const;

/**
 * The single correlation object threaded through the inbound -> prompt ->
 * outbound path. It feeds span attributes and structured-log fields from the
 * same source, so logs and traces always agree.
 */
export interface CorrelationContext {
	channelId?: string;
	conversationId?: string;
	sessionKey?: string;
	acpSessionId?: string;
	agentId?: string;
	promptCycleId?: string;
}

const CORRELATION_ATTRIBUTE_KEYS: ReadonlyArray<
	readonly [keyof CorrelationContext, string]
> = [
	["channelId", "acpantenna.channel_id"],
	["conversationId", "acpantenna.conversation_id"],
	["sessionKey", "acpantenna.session_key"],
	["acpSessionId", "acpantenna.acp_session_id"],
	["agentId", "acpantenna.agent_id"],
	["promptCycleId", "acpantenna.prompt_cycle_id"],
];

/** Map a correlation context to span attributes, omitting unset fields. */
export function correlationAttributes(context: CorrelationContext): Attributes {
	const attributes: Attributes = {};

	for (const [field, attribute] of CORRELATION_ATTRIBUTE_KEYS) {
		const value = context[field];

		if (value !== undefined) {
			attributes[attribute] = value;
		}
	}

	return attributes;
}

export interface WithSpanOptions {
	/** Tracer to use. Defaults to the globally registered provider's tracer. */
	tracer?: Tracer;
	name: string;
	correlation?: CorrelationContext;
	attributes?: Attributes;
}

/**
 * Run `run` inside an active span, attaching correlation attributes, recording
 * exceptions, and always ending the span. With no tracer registered globally
 * this is a no-op span, so instrumentation is free until a provider is set up.
 */
export function withSpan<T>(
	options: WithSpanOptions,
	run: (span: Span) => Promise<T> | T,
): Promise<T> {
	const tracer = options.tracer ?? trace.getTracer(SERVICE_NAME);

	return tracer.startActiveSpan(
		options.name,
		{
			attributes: {
				...correlationAttributes(options.correlation ?? {}),
				...options.attributes,
			},
		},
		async (span) => {
			try {
				const result = await run(span);
				span.setStatus({ code: SpanStatusCode.OK });
				return result;
			} catch (error) {
				const normalized =
					error instanceof Error ? error : new Error(String(error));
				span.recordException(normalized);
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: normalized.message,
				});
				throw error;
			} finally {
				span.end();
			}
		},
	);
}
