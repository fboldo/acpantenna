import { type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	ConsoleSpanExporter,
	SimpleSpanProcessor,
	type SpanExporter,
	type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { SERVICE_NAME } from "./instrument.ts";

// Re-export the api-only instrumentation helpers so the main entry stays a
// superset. Consumers that must not pull the OTEL SDK (e.g. the gateway core)
// should import "@acpantenna/observability/instrument" instead.
export * from "./instrument.ts";

/**
 * Requested exporter. `auto` picks OTLP when an endpoint is known, else none:
 * a long-running service should not write every span to its stdout unless
 * asked to.
 */
export type ExporterKind = "auto" | "otlp" | "console" | "none";

/** Exporter actually wired up by {@link createTelemetry}. */
export type EffectiveExporter = "otlp" | "console" | "none" | "custom";

export interface TelemetryOptions {
	serviceName?: string;
	serviceVersion?: string;
	/**
	 * Explicit OTLP traces endpoint URL. When omitted, the standard
	 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`
	 * environment variables are consulted.
	 */
	otlpEndpoint?: string;
	/**
	 * Force a specific exporter. Defaults to the standard `OTEL_TRACES_EXPORTER`
	 * environment variable (`otlp`, `console` or `none`), else `auto`.
	 */
	exporter?: ExporterKind;
	/** Custom exporter (e.g. an in-memory exporter in tests). Wins over `exporter`. */
	spanExporter?: SpanExporter;
	/**
	 * Register the provider as the global API provider so `trace.getTracer()`
	 * works application-wide. Defaults to true.
	 */
	setGlobal?: boolean;
	/** Environment source for endpoint discovery. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

export interface Telemetry {
	tracer: Tracer;
	/** The exporter that was actually wired up. */
	exporterKind: EffectiveExporter;
	forceFlush(): Promise<void>;
	shutdown(): Promise<void>;
}

interface ResolvedExporter {
	kind: EffectiveExporter;
	processor?: SpanProcessor;
}

function resolveOtlpEndpoint(options: TelemetryOptions): string | undefined {
	if (options.otlpEndpoint) {
		return options.otlpEndpoint;
	}

	const env = options.env ?? process.env;

	return (
		env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT
	);
}

function resolveExporter(options: TelemetryOptions): ResolvedExporter {
	if (options.spanExporter) {
		return {
			kind: "custom",
			processor: new SimpleSpanProcessor(options.spanExporter),
		};
	}

	const requested = options.exporter ?? exporterFromEnv(options);

	if (requested === "none") {
		return { kind: "none" };
	}

	const endpoint = resolveOtlpEndpoint(options);
	const useOtlp = requested === "otlp" || (requested === "auto" && !!endpoint);

	if (useOtlp) {
		const exporter = new OTLPTraceExporter(
			options.otlpEndpoint ? { url: options.otlpEndpoint } : {},
		);

		return { kind: "otlp", processor: new BatchSpanProcessor(exporter) };
	}

	if (requested === "console") {
		// Spans on the gateway's own stdout, for local debugging. Safe for the
		// protocol: ACP framing lives on each agent subprocess's piped stdout.
		return {
			kind: "console",
			processor: new SimpleSpanProcessor(new ConsoleSpanExporter()),
		};
	}

	// No endpoint and nothing asked for: spans are made but not exported.
	return { kind: "none" };
}

/** `OTEL_TRACES_EXPORTER`, as the OpenTelemetry spec names it; unknown values mean auto. */
function exporterFromEnv(options: TelemetryOptions): ExporterKind {
	const env = options.env ?? process.env;
	const value = env.OTEL_TRACES_EXPORTER?.trim().toLowerCase();

	return value === "otlp" || value === "console" || value === "none"
		? value
		: "auto";
}

/**
 * Create an OpenTelemetry tracer provider: export over OTLP when an endpoint
 * is configured, to stdout when `OTEL_TRACES_EXPORTER=console` asks for it,
 * otherwise nowhere.
 */
export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
	const resource = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: options.serviceName ?? SERVICE_NAME,
		[ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.0.0",
	});

	const resolved = resolveExporter(options);
	const provider = new BasicTracerProvider({
		resource,
		spanProcessors: resolved.processor ? [resolved.processor] : [],
	});

	if (options.setGlobal ?? true) {
		trace.setGlobalTracerProvider(provider);
	}

	return {
		tracer: provider.getTracer(SERVICE_NAME),
		exporterKind: resolved.kind,
		forceFlush: () => provider.forceFlush(),
		shutdown: () => provider.shutdown(),
	};
}
