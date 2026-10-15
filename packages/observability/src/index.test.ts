import { expect, test } from "bun:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
	type CorrelationContext,
	correlationAttributes,
	createTelemetry,
	SPAN_NAMES,
	withSpan,
} from "./index.ts";

test("records a span with correlation attributes through a custom exporter", async () => {
	const exporter = new InMemorySpanExporter();
	const telemetry = createTelemetry({
		spanExporter: exporter,
		setGlobal: false,
	});

	expect(telemetry.exporterKind).toBe("custom");

	const result = await withSpan(
		{
			tracer: telemetry.tracer,
			name: SPAN_NAMES.promptTurn,
			correlation: { channelId: "webhook", acpSessionId: "s-1" },
			attributes: { "acp.stop_reason": "end_turn" },
		},
		() => "ok",
	);

	expect(result).toBe("ok");
	await telemetry.forceFlush();

	const spans = exporter.getFinishedSpans();
	expect(spans).toHaveLength(1);
	expect(spans[0]?.name).toBe("acp.prompt.turn");
	expect(spans[0]?.attributes["acpantenna.channel_id"]).toBe("webhook");
	expect(spans[0]?.attributes["acpantenna.acp_session_id"]).toBe("s-1");
	expect(spans[0]?.attributes["acp.stop_reason"]).toBe("end_turn");

	await telemetry.shutdown();
});

test("records an error status and rethrows when the span body throws", async () => {
	const exporter = new InMemorySpanExporter();
	const telemetry = createTelemetry({
		spanExporter: exporter,
		setGlobal: false,
	});

	const failure = new Error("boom");

	await expect(
		withSpan({ tracer: telemetry.tracer, name: SPAN_NAMES.sessionNew }, () => {
			throw failure;
		}),
	).rejects.toThrow("boom");

	await telemetry.forceFlush();

	const spans = exporter.getFinishedSpans();
	expect(spans).toHaveLength(1);
	// SpanStatusCode.ERROR === 2
	expect(spans[0]?.status.code).toBe(2);

	await telemetry.shutdown();
});

test("omits unset correlation fields", () => {
	const context: CorrelationContext = { agentId: "default" };

	expect(correlationAttributes(context)).toEqual({
		"acpantenna.agent_id": "default",
	});
});

test("exports nothing when no OTLP endpoint is configured", () => {
	const telemetry = createTelemetry({ setGlobal: false, env: {} });

	expect(telemetry.exporterKind).toBe("none");
});

test("prints spans to stdout only when OTEL_TRACES_EXPORTER asks for it", () => {
	expect(
		createTelemetry({
			setGlobal: false,
			env: { OTEL_TRACES_EXPORTER: "console" },
		}).exporterKind,
	).toBe("console");
	expect(
		createTelemetry({ setGlobal: false, env: {}, exporter: "console" })
			.exporterKind,
	).toBe("console");
	expect(
		createTelemetry({
			setGlobal: false,
			env: {
				OTEL_TRACES_EXPORTER: "none",
				OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
			},
		}).exporterKind,
	).toBe("none");
});

test("selects OTLP when an endpoint is configured", () => {
	const telemetry = createTelemetry({
		setGlobal: false,
		env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
	});

	expect(telemetry.exporterKind).toBe("otlp");
});

test("honours an explicit none exporter", () => {
	const telemetry = createTelemetry({ setGlobal: false, exporter: "none" });

	expect(telemetry.exporterKind).toBe("none");
});
