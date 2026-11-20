import type { EventMap, EventName } from '@am/core';
import { sql, type Kysely, type Migration } from 'kysely';
import type { Logger } from 'pino';
import { platformMetrics } from './telemetry/metrics.js';
import { currentTraceCarrier, withSpan, type TraceCarrier } from './telemetry/tracing.js';

/**
 * Transactional outbox: events are written in the same transaction as the
 * state change, then relayed to pg-boss. Delivery is at-least-once, so every
 * consumer must be idempotent.
 */
export interface OutboxTable {
  outbox: {
    id: import('kysely').Generated<number>;
    event: string;
    payload: unknown;
    created_at: import('kysely').Generated<Date>;
    published_at: Date | null;
  };
}

export const outboxMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable('outbox')
      .addColumn('id', 'bigserial', (c) => c.primaryKey())
      .addColumn('event', 'text', (c) => c.notNull())
      .addColumn('payload', 'jsonb', (c) => c.notNull())
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('published_at', 'timestamptz')
      .execute();
    await sql`create index outbox_unpublished on outbox (id) where published_at is null`.execute(db);
  },
};

/** Trace context travels with the event, so a consumer's work joins the trace of the request that caused it. */
const TRACE_KEY = '_trace';

export async function enqueue<DB extends OutboxTable, E extends EventName>(db: Kysely<DB>, event: E, payload: EventMap[E]): Promise<void> {
  const trace = currentTraceCarrier();
  const data = trace ? { ...payload, [TRACE_KEY]: trace } : payload;
  await (db as unknown as Kysely<OutboxTable>).insertInto('outbox').values({ event, payload: JSON.stringify(data), published_at: null }).execute();
}

export async function outboxBacklog(db: Kysely<OutboxTable>): Promise<number> {
  const r = await db.selectFrom('outbox').select((eb) => eb.fn.countAll<number>().as('n')).where('published_at', 'is', null).executeTakeFirstOrThrow();
  return Number(r.n);
}

export type EventHandler<E extends EventName> = (payload: EventMap[E]) => Promise<void>;

/**
 * Delivers integration events to every subscribed consumer (fan-out), at least
 * once. On the server: pg-boss queues in Postgres (`@am/platform/node`).
 * In the browser: an in-memory queue (`@am/browser-runtime`).
 */
export interface EventBus {
  publish<E extends EventName>(event: E, payload: EventMap[E]): Promise<void>;
  /** `consumer` names the durable queue, so each service gets its own copy of the event. */
  subscribe<E extends EventName>(consumer: string, event: E, handler: EventHandler<E>): Promise<void>;
  /** Runs `handler` once per cron tick across all replicas. */
  schedule(queue: string, cron: string, handler: () => Promise<void>): Promise<void>;
}

/** Strips the trace context off an event and runs one consumer on it, with a span and metrics. Throws to request a retry. */
export async function handleEvent<E extends EventName>(
  consumer: string,
  event: E,
  data: unknown,
  handler: EventHandler<E>,
  logger: Logger,
  attributes: Record<string, string | number> = {},
): Promise<void> {
  const { [TRACE_KEY]: parent, ...payload } = data as EventMap[E] & { [TRACE_KEY]?: TraceCarrier };
  const stop = platformMetrics.eventDuration.startTimer({ consumer, event });
  try {
    await withSpan(`${event} process`, { kind: 'consumer', parent, attributes }, () => handler(payload as unknown as EventMap[E]));
    platformMetrics.eventsHandled.inc({ consumer, event, outcome: 'success' });
  } catch (err) {
    platformMetrics.eventsHandled.inc({ consumer, event, outcome: 'failure' });
    logger.error({ err, consumer, event, ...attributes }, 'event handler failed');
    throw err;
  } finally {
    stop();
  }
}

/** Runs one scheduled job tick, with a span and metrics. */
export async function runJob(queue: string, handler: () => Promise<void>): Promise<void> {
  try {
    await withSpan(`job ${queue}`, {}, handler);
    platformMetrics.jobRuns.inc({ job: queue, outcome: 'success' });
    platformMetrics.jobLastSuccess.set({ job: queue }, Date.now() / 1000);
  } catch (err) {
    platformMetrics.jobRuns.inc({ job: queue, outcome: 'failure' });
    throw err;
  }
}

/** Publishes committed outbox rows (up to 100). Safe to run in several replicas (SKIP LOCKED). Returns how many it sent. */
export async function relayOutbox(db: Kysely<OutboxTable>, bus: EventBus): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx.selectFrom('outbox').selectAll().where('published_at', 'is', null).orderBy('id').limit(100).forUpdate().skipLocked().execute();
    for (const row of rows) {
      await bus.publish(row.event as EventName, row.payload as never);
      platformMetrics.eventsPublished.inc({ event: row.event });
    }
    if (rows.length) {
      await trx.updateTable('outbox').set({ published_at: new Date() }).where('id', 'in', rows.map((r) => r.id)).execute();
    }
    return rows.length;
  });
}

/** Relays the outbox on an interval until stopped. */
export function startOutboxRelay(db: Kysely<OutboxTable>, bus: EventBus, logger: Logger, intervalMs = 1000): () => Promise<void> {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      while ((await relayOutbox(db, bus)) === 100 && !stopped);
    } catch (err) {
      logger.error({ err }, 'outbox relay failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (running) await new Promise((r) => setTimeout(r, 50));
  };
}

