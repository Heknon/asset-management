import client from 'prom-client';
import { setMetricsBackend, type MetricsBackend } from '../telemetry/metrics.js';

/**
 * Prometheus metrics, scraped from GET /metrics by Prometheus, VictoriaMetrics
 * (vmagent / VMServiceScrape) or OpenShift user-workload monitoring.
 */
export const registry = new client.Registry();

const prometheus: MetricsBackend = {
  counter: (c) => new client.Counter({ name: c.name, help: c.help, labelNames: c.labelNames ?? [], registers: [registry] }),
  gauge: (c) => new client.Gauge({ name: c.name, help: c.help, labelNames: c.labelNames ?? [], registers: [registry] }),
  histogram: (c) => new client.Histogram({ name: c.name, help: c.help, labelNames: c.labelNames ?? [], buckets: c.buckets, registers: [registry] }),
};
setMetricsBackend(prometheus);

let initialised = false;
export function initMetrics(service: string): void {
  if (initialised) return;
  initialised = true;
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });
}

/** Gauges computed at scrape time (pool sizes, backlog), registered by the server runtime. */
export function collectedGauge(name: string, help: string, collect: (set: (labels: Record<string, string>, v: number) => void) => Promise<void> | void, labelNames: string[] = []): void {
  new client.Gauge({
    name,
    help,
    labelNames,
    registers: [registry],
    async collect() {
      await collect((labels, v) => this.set(labels, v));
    },
  });
}
