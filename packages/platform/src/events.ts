import type { EventMap, EventName } from '@am/core';
import { sql, type Kysely, type Migration } from 'kysely';
import type { Logger } from 'pino';
import PgBoss from 'pg-boss';
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
 * Queue setup takes table locks; when every replica of every service starts at
 * once (fresh install, cluster restart) these can deadlock. Retry with jitter.
 */
async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (i >= attempts || (code !== '40P01' && code !== '40001' && code !== '23505')) throw err;
      await new Promise((r) => setTimeout(r, 100 * i + Math.random() * 400));
    }
  }
}

export class EventBus {
  constructor(
    private readonly boss: PgBoss,
    private readonly logger: Logger,
  ) {}

  publish<E extends EventName>(event: E, payload: EventMap[E]): Promise<void> {
    return this.boss.publish(event, payload as object);
  }

  /** Each consumer gets its own durable queue subscribed to the event (fan-out). */
  async subscribe<E extends EventName>(consumer: string, event: E, handler: EventHandler<E>): Promise<void> {
    const queue = `${consumer}.${event}`;
    await withDeadlockRetry(() => this.boss.createQueue(queue, { name: queue, retryLimit: 10, retryBackoff: true, retryDelay: 5 }));
    await withDeadlockRetry(() => this.boss.subscribe(event, queue));
    await this.boss.work<EventMap[E]>(queue, { batchSize: 25, pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) {
        const { [TRACE_KEY]: parent, ...payload } = job.data as EventMap[E] & { [TRACE_KEY]?: TraceCarrier };
        const stop = platformMetrics.eventDuration.startTimer({ consumer, event });
        try {
          await withSpan(`${event} process`, { kind: 'consumer', parent, attributes: { 'messaging.system': 'pg-boss', 'messaging.destination.name': queue, 'messaging.message.id': job.id } }, () =>
            handler(payload as EventMap[E]),
          );
          platformMetrics.eventsHandled.inc({ consumer, event, outcome: 'success' });
        } catch (err) {
          platformMetrics.eventsHandled.inc({ consumer, event, outcome: 'failure' });
          this.logger.error({ err, queue, jobId: job.id }, 'event handler failed');
          throw err;
        } finally {
          stop();
        }
      }
    });
  }

  /** Cron job that runs once per tick across all replicas (pg-boss singleton queue). */
  async schedule(queue: string, cron: string, handler: () => Promise<void>): Promise<void> {
    await withDeadlockRetry(() => this.boss.createQueue(queue, { name: queue, policy: 'singleton', retryLimit: 0 }));
    await withDeadlockRetry(() => this.boss.schedule(queue, cron, {}, { tz: 'UTC' }));
    await this.boss.work(queue, async () => {
      try {
        await withSpan(`job ${queue}`, {}, handler);
        platformMetrics.jobRuns.inc({ job: queue, outcome: 'success' });
        platformMetrics.jobLastSuccess.set({ job: queue }, Date.now() / 1000);
      } catch (err) {
        platformMetrics.jobRuns.inc({ job: queue, outcome: 'failure' });
        throw err;
      }
    });
  }
}

/** Moves committed outbox rows to the bus. Safe to run in several replicas (SKIP LOCKED). */
export function startOutboxRelay(db: Kysely<OutboxTable>, bus: EventBus, logger: Logger, intervalMs = 1000): () => Promise<void> {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await db.transaction().execute(async (trx) => {
        const rows = await trx.selectFrom('outbox').selectAll().where('published_at', 'is', null).orderBy('id').limit(100).forUpdate().skipLocked().execute();
        for (const row of rows) {
          await bus.publish(row.event as EventName, row.payload as never);
          platformMetrics.eventsPublished.inc({ event: row.event });
        }
        if (rows.length) {
          await trx.updateTable('outbox').set({ published_at: new Date() }).where('id', 'in', rows.map((r) => r.id)).execute();
        }
      });
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

export { PgBoss };
