import type { EventMap, EventName } from '@am/core';
import { sql, type Kysely, type Migration } from 'kysely';
import type { Logger } from 'pino';
import PgBoss from 'pg-boss';

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

export async function enqueue<DB extends OutboxTable, E extends EventName>(db: Kysely<DB>, event: E, payload: EventMap[E]): Promise<void> {
  await (db as unknown as Kysely<OutboxTable>).insertInto('outbox').values({ event, payload: JSON.stringify(payload), published_at: null }).execute();
}

export type EventHandler<E extends EventName> = (payload: EventMap[E]) => Promise<void>;

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
    await this.boss.createQueue(queue, { name: queue, retryLimit: 10, retryBackoff: true, retryDelay: 5 });
    await this.boss.subscribe(event, queue);
    await this.boss.work<EventMap[E]>(queue, { batchSize: 25, pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) {
        try {
          await handler(job.data);
        } catch (err) {
          this.logger.error({ err, queue, jobId: job.id }, 'event handler failed');
          throw err;
        }
      }
    });
  }

  /** Cron job that runs once per tick across all replicas (pg-boss singleton queue). */
  async schedule(queue: string, cron: string, handler: () => Promise<void>): Promise<void> {
    await this.boss.createQueue(queue, { name: queue, policy: 'singleton', retryLimit: 0 });
    await this.boss.schedule(queue, cron, {}, { tz: 'UTC' });
    await this.boss.work(queue, async () => handler());
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
        for (const row of rows) await bus.publish(row.event as EventName, row.payload as never);
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
