import type { EventMap, EventName } from '@am/core';
import { handleEvent, runJob, type EventBus, type EventHandler } from '@am/platform';
import type { Logger } from 'pino';
import type { TaskQueue } from './queue.js';

const MAX_ATTEMPTS = 10;

/**
 * The browser's event bus: the same fan-out as pg-boss on the server (each
 * consumer gets its own copy of every event it subscribed to), delivered as
 * queued tasks, retried with backoff when a handler fails.
 */
export class InMemoryEventBus implements EventBus {
  private readonly subscribers = new Map<string, Array<{ consumer: string; handler: EventHandler<never> }>>();
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(
    private readonly queue: TaskQueue,
    private readonly logger: Logger,
    /** Runs after every delivered event, so the outboxes its handler wrote to are relayed in turn. */
    private readonly afterTask: () => Promise<void>,
  ) {}

  async publish<E extends EventName>(event: E, payload: EventMap[E]): Promise<void> {
    for (const s of this.subscribers.get(event) ?? []) this.deliver(s.consumer, event, payload, s.handler as EventHandler<E>, 1);
  }

  async subscribe<E extends EventName>(consumer: string, event: E, handler: EventHandler<E>): Promise<void> {
    const list = this.subscribers.get(event) ?? [];
    list.push({ consumer, handler: handler as EventHandler<never> });
    this.subscribers.set(event, list);
  }

  /** Runs on the cron's interval (every N minutes for "*\/N * * * *", else every 15) while the browser is open. */
  async schedule(queue: string, cron: string, handler: () => Promise<void>): Promise<void> {
    const minutes = Number(/^\*\/(\d+)\s/.exec(cron)?.[1] ?? 15);
    const tick = () =>
      void this.queue
        .run(async () => {
          await runJob(queue, handler);
          await this.afterTask();
        })
        .catch((err) => this.logger.error({ err, queue }, 'scheduled job failed'));
    setTimeout(tick, 5_000);
    this.timers.push(setInterval(tick, minutes * 60_000));
  }

  private deliver<E extends EventName>(consumer: string, event: E, payload: EventMap[E], handler: EventHandler<E>, attempt: number): void {
    void this.queue
      .run(async () => {
        await handleEvent(consumer, event, payload, handler, this.logger, { attempt });
        await this.afterTask();
      })
      .catch(() => {
        if (attempt >= MAX_ATTEMPTS) return this.logger.error({ consumer, event }, 'event dropped after retries');
        setTimeout(() => this.deliver(consumer, event, payload, handler, attempt + 1), Math.min(60_000, 1000 * 2 ** attempt));
      });
  }

  stop(): void {
    this.timers.splice(0).forEach(clearInterval);
  }
}
