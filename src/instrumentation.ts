// OpenTelemetry for the web app. Disabled unless an OTLP endpoint is configured, so local
// development and tests have no telemetry dependency.
export async function register() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerOTel } = await import("@vercel/otel");
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? "creator-farm-web" });
}
