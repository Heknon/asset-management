/**
 * Everything the runtime does (HTTP requests, event deliveries, scheduled
 * jobs) runs one task at a time, in order. With a single Postgres session
 * this keeps one request's transaction from interleaving with another's.
 */
export class TaskQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private waiters: Array<() => void> = [];

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const next = this.tail.then(task, task).finally(() => {
      if (--this.pending === 0) this.waiters.splice(0).forEach((w) => w());
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Resolves once nothing is queued or running (events from earlier work included). */
  idle(): Promise<void> {
    return this.pending === 0 ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }
}
