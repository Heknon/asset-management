import type { Mailer } from './ports.js';
import type { SchedulerStore } from './ports.js';

/**
 * Events are delivered at least once: a retried event must not email the
 * people it already reached. Each (event, recipient) is sent once.
 */
export function eventKey(channel: string, event: unknown): string {
  return `${channel}:${hash(JSON.stringify(event))}`;
}

/** Two independent 32-bit FNV-1a hashes: plain JS, so it runs in the browser too. */
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}${text.length.toString(16)}`;
}

export async function sendOnce(store: Pick<SchedulerStore, 'notificationSent' | 'markNotificationSent'>, mailer: Mailer, key: string, message: Parameters<Mailer['send']>[0]): Promise<boolean> {
  const k = `${key}:${message.to.toLowerCase()}`;
  if (await store.notificationSent(k)) return false;
  await mailer.send(message);
  await store.markNotificationSent(k);
  return true;
}
