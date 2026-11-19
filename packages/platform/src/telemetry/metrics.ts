/**
 * Business and platform metrics through a small facade. Instruments can be
 * declared anywhere (module scope included); they record into whichever
 * backend the runtime installs: Prometheus on the server
 * (`@am/platform/node`), nothing in the browser.
 */
type Labels<L extends string> = Partial<Record<L, string | number>>;

export interface CounterConfig<L extends string> {
  name: string;
  help: string;
  labelNames?: readonly L[];
}
export interface HistogramConfig<L extends string> extends CounterConfig<L> {
  buckets?: number[];
}

export interface Counter<L extends string> {
  inc(labels?: Labels<L>, value?: number): void;
}
export interface Gauge<L extends string> {
  set(labels: Labels<L>, value: number): void;
}
export interface Histogram<L extends string> {
  observe(labels: Labels<L>, seconds: number): void;
  /** Returns a function that records the elapsed time. */
  startTimer(labels?: Labels<L>): () => void;
}

export interface MetricsBackend {
  counter<L extends string>(c: CounterConfig<L>): Counter<L>;
  gauge<L extends string>(c: CounterConfig<L>): Gauge<L>;
  histogram<L extends string>(c: HistogramConfig<L>): Histogram<L>;
}

let backend: MetricsBackend | null = null;

/** Installed once by the runtime (Prometheus on the server). Without one, instruments are no-ops. */
export function setMetricsBackend(b: MetricsBackend): void {
  backend = b;
}

/** Creates the real instrument on first use, so declaring one never depends on start-up order. */
function lazy<T>(make: (b: MetricsBackend) => T): () => T | null {
  let made: T | null = null;
  return () => (made ??= backend ? make(backend) : null);
}

export const metrics = {
  counter<L extends string>(c: CounterConfig<L>): Counter<L> {
    const get = lazy((b) => b.counter(c));
    return { inc: (labels, value) => get()?.inc(labels, value) };
  },
  gauge<L extends string>(c: CounterConfig<L>): Gauge<L> {
    const get = lazy((b) => b.gauge(c));
    return { set: (labels, value) => get()?.set(labels, value) };
  },
  histogram<L extends string>(c: HistogramConfig<L>): Histogram<L> {
    const get = lazy((b) => b.histogram(c));
    return {
      observe: (labels, seconds) => get()?.observe(labels, seconds),
      startTimer: (labels) => get()?.startTimer(labels) ?? (() => undefined),
    };
  },
};

/** Baseline instruments shared by every service. */
export const platformMetrics = {
  http: metrics.histogram({
    name: 'http_server_request_duration_seconds',
    help: 'HTTP request duration by route and status',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  }),
  eventsHandled: metrics.counter({ name: 'am_events_handled_total', help: 'Integration events processed by consumers', labelNames: ['consumer', 'event', 'outcome'] }),
  eventDuration: metrics.histogram({
    name: 'am_event_handler_duration_seconds',
    help: 'Time to process one integration event',
    labelNames: ['consumer', 'event'],
    buckets: [0.005, 0.025, 0.1, 0.25, 1, 2.5, 10],
  }),
  eventsPublished: metrics.counter({ name: 'am_events_published_total', help: 'Integration events relayed from the outbox', labelNames: ['event'] }),
  jobRuns: metrics.counter({ name: 'am_scheduled_job_runs_total', help: 'Scheduled job runs', labelNames: ['job', 'outcome'] }),
  jobLastSuccess: metrics.gauge({ name: 'am_scheduled_job_last_success_timestamp_seconds', help: 'Unix time of the last successful run of a scheduled job', labelNames: ['job'] }),
};
