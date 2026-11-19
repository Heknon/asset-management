import type { EventMap, EventName } from '@am/core';
import type { Logger } from 'pino';
import PgBoss from 'pg-boss';
import { handleEvent, runJob, type EventBus, type EventHandler } from '../events.js';

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

/** The server's event bus: durable pg-boss queues in Postgres, retried with backoff. */
export class PgBossEventBus implements EventBus {
  constructor(
    private readonly boss: PgBoss,
    private readonly logger: Logger,
  ) {}

  publish<E extends EventName>(event: E, payload: EventMap[E]): Promise<void> {
    return this.boss.publish(event, payload as object);
  }

  async subscribe<E extends EventName>(consumer: string, event: E, handler: EventHandler<E>): Promise<void> {
    const queue = `${consumer}.${event}`;
    await withDeadlockRetry(() => this.boss.createQueue(queue, { name: queue, retryLimit: 10, retryBackoff: true, retryDelay: 5 }));
    await withDeadlockRetry(() => this.boss.subscribe(event, queue));
    await this.boss.work(queue, { batchSize: 25, pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) {
        await handleEvent(consumer, event, job.data, handler, this.logger, { 'messaging.system': 'pg-boss', 'messaging.destination.name': queue, 'messaging.message.id': job.id });
      }
    });
  }

  async schedule(queue: string, cron: string, handler: () => Promise<void>): Promise<void> {
    await withDeadlockRetry(() => this.boss.createQueue(queue, { name: queue, policy: 'singleton', retryLimit: 0 }));
    await withDeadlockRetry(() => this.boss.schedule(queue, cron, {}, { tz: 'UTC' }));
    await this.boss.work(queue, () => runJob(queue, handler));
  }
}

export { PgBoss };
