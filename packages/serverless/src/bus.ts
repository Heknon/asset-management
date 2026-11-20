import type { EventMap, EventName } from '@am/core';
import { handleEvent, runJob, type EventBus, type EventHandler } from '@am/platform';
import { type PgBoss, withDeadlockRetry } from '@am/platform/node';
import type { Logger } from 'pino';

/**
 * The server's durable pg-boss queues without its always-on workers: events
 * fan out to each consumer's queue as on the server, and waiting deliveries
 * run when `drain()` is called (after a change, and on every cron run).
 * Failures stay in the queue and are retried with backoff on a later drain.
 */
export class DrainEventBus implements EventBus {
  private readonly consumers = new Map<string, { consumer: string; event: EventName; handler: EventHandler<never> }>();
  private readonly jobs = new Map<string, () => Promise<void>>();

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
    this.consumers.set(queue, { consumer, event, handler: handler as EventHandler<never> });
  }

  /** Scheduled jobs run on each cron call instead of on their own schedule. */
  async schedule(queue: string, _cron: string, handler: () => Promise<void>): Promise<void> {
    this.jobs.set(queue, handler);
  }

  /** Runs waiting deliveries until none are left or `deadline` (epoch ms) passes. Returns how many ran. */
  async drain(deadline: number): Promise<number> {
    let total = 0;
    for (;;) {
      let ran = 0;
      for (const [queue, c] of this.consumers) {
        if (Date.now() > deadline) return total + ran;
        const jobs = await this.boss.fetch<unknown>(queue, { batchSize: 25 });
        for (const job of jobs) {
          try {
            await handleEvent(c.consumer, c.event as never, job.data, c.handler, this.logger, { 'messaging.system': 'pg-boss', 'messaging.destination.name': queue, 'messaging.message.id': job.id });
            await this.boss.complete(queue, job.id);
          } catch (err) {
            await this.boss.fail(queue, job.id, { message: err instanceof Error ? err.message : String(err) });
          }
          ran++;
        }
      }
      total += ran;
      if (!ran) return total;
    }
  }

  /** Runs every scheduled job once (reminders, housekeeping). One failing does not stop the others. */
  async runScheduled(): Promise<Record<string, 'ok' | 'failed'>> {
    const report: Record<string, 'ok' | 'failed'> = {};
    for (const [queue, handler] of this.jobs) {
      try {
        await runJob(queue, handler);
        report[queue] = 'ok';
      } catch (err) {
        this.logger.error({ err, job: queue }, 'scheduled job failed');
        report[queue] = 'failed';
      }
    }
    return report;
  }
}
