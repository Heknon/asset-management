/**
 * Distributed tracing bootstrap, preloaded before the service:
 *   node --import ./dist/telemetry.mjs dist/main.mjs
 *
 * Off unless OTEL_ENABLED=true. When on, it auto-instruments HTTP (Fastify),
 * outgoing fetch, Postgres, the AWS SDK and pino, and exports traces over OTLP
 * to any OpenTelemetry collector — or straight to Elastic APM, which accepts
 * OTLP natively. Configuration is the standard OTEL_* environment:
 *   OTEL_EXPORTER_OTLP_ENDPOINT   http://otel-collector:4318  |  https://apm.example.com:8200
 *   OTEL_EXPORTER_OTLP_PROTOCOL   http/protobuf (default) | grpc
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer <Elastic APM secret token>
 *   OTEL_TRACES_SAMPLER(_ARG)     parentbased_traceidratio / 0.1
 *   OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES
 */
import { register } from 'node:module';

const enabled = ['true', '1', 'yes'].includes((process.env.OTEL_ENABLED ?? '').toLowerCase());

if (enabled) {
  // ESM support: lets instrumentations patch modules loaded with `import`.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const [{ NodeSDK }, { getNodeAutoInstrumentations }, proto, grpc] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-proto'),
    import('@opentelemetry/exporter-trace-otlp-grpc'),
  ]);

  const protocol = process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf';
  const traceExporter = protocol === 'grpc' ? new grpc.OTLPTraceExporter() : new proto.OTLPTraceExporter();
  const quiet = new Set(['/healthz', '/readyz', '/metrics']);

  const sdk = new NodeSDK({
    traceExporter,
    // Metrics are pulled from /metrics (Prometheus/VictoriaMetrics); OTel handles traces only.
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // Log correlation is done by our own pino mixin (plain or ECS field names).
        '@opentelemetry/instrumentation-pino': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => quiet.has((req.url ?? '').split('?')[0]!),
        },
        '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false, requireParentSpan: true },
      }),
    ],
  });
  sdk.start();

  // The service's own shutdown sequence flushes spans before the process exits.
  (globalThis as { __amTelemetryShutdown?: () => Promise<void> }).__amTelemetryShutdown = () => sdk.shutdown();
}
