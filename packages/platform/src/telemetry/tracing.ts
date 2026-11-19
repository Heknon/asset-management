import { context, propagation, SpanKind, SpanStatusCode, trace, type Context } from '@opentelemetry/api';

/**
 * Thin helpers over the OpenTelemetry API. They are no-ops unless the
 * bootstrap started the SDK, so call sites need no feature checks.
 */
export const tracer = trace.getTracer('asset-management');

export type TraceCarrier = Record<string, string>;

/** W3C trace context of the current span, to travel inside an event. */
export function currentTraceCarrier(): TraceCarrier | undefined {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length ? carrier : undefined;
}

/** Runs `fn` in a span that continues the trace an event was published in. */
export async function withSpan<T>(name: string, opts: { kind?: 'consumer' | 'internal'; parent?: TraceCarrier; attributes?: Record<string, string | number> }, fn: () => Promise<T>): Promise<T> {
  const parent: Context = opts.parent ? propagation.extract(context.active(), opts.parent) : context.active();
  return tracer.startActiveSpan(name, { kind: opts.kind === 'consumer' ? SpanKind.CONSUMER : SpanKind.INTERNAL, attributes: opts.attributes }, parent, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Log correlation. Plain JSON gets trace_id/span_id; ECS gets trace.id/span.id
 * so Elastic links log lines to APM traces.
 */
export function traceLogFields(format: 'json' | 'ecs'): Record<string, string> {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (!ctx || !trace.isSpanContextValid(ctx)) return {};
  return format === 'ecs' ? { 'trace.id': ctx.traceId, 'span.id': ctx.spanId, 'transaction.id': ctx.spanId } : { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/** Flushes spans on shutdown (set by the bootstrap when tracing is on). */
export async function shutdownTracing(): Promise<void> {
  await (globalThis as { __amTelemetryShutdown?: () => Promise<void> }).__amTelemetryShutdown?.();
}
