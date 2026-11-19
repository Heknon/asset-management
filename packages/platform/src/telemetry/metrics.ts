import client, { type CounterConfiguration, type GaugeConfiguration, type HistogramConfiguration } from 'prom-client';

/**
 * Prometheus metrics, scraped from GET /metrics by Prometheus, VictoriaMetrics
 * (vmagent / VMServiceScrape) or OpenShift user-workload monitoring.
 * Every service gets the same baseline (process, HTTP, events, outbox, DB pool);
 * services add their own business metrics through `metrics`.
 */
export const registry = new client.Registry();

let initialised = false;
export function initMetrics(service: string): void {
  if (initialised) return;
  initialised = true;
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });
}

export const metrics = {
  counter: <T extends string>(c: Omit<CounterConfiguration<T>, 'registers'>) => new client.Counter<T>({ ...c, registers: [registry] }),
  gauge: <T extends string>(c: Omit<GaugeConfiguration<T>, 'registers'>) => new client.Gauge<T>({ ...c, registers: [registry] }),
  histogram: <T extends string>(c: Omit<HistogramConfiguration<T>, 'registers'>) => new client.Histogram<T>({ ...c, registers: [registry] }),
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
