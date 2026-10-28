// OpenTelemetry for workers. Exporting is enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set
// (e.g. an ADOT collector sidecar sending to X-Ray); otherwise the API is a no-op. Every job runs
// in a span; outgoing fetch calls (providers, platforms) become child spans.

import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import { logger } from "./logger";

let started = false;

export async function initTelemetry(serviceName: string) {
  if (started || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  const { registerOTel } = await import("@vercel/otel");
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? serviceName });
  started = true;
  logger.info({ serviceName }, "telemetry enabled");
  return true;
}

export const tracer = () => trace.getTracer("creator-farm-worker");

/** Runs fn in a span; failures are recorded on the span and re-thrown. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
