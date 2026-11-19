import type { Mailer } from '@am/scheduler/service';
import { kv } from './kv.js';

export interface SentMail {
  id: string;
  at: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  calendar: { method: 'REQUEST' | 'CANCEL'; content: string } | null;
}

const KEEP = 200;

/**
 * Where reminders, renewal asks and request emails go when there is no mail
 * server: a mailbox kept in this browser, shown on the "Sent emails" page so
 * every notification can still be read.
 */
export const browserMailer: Mailer = {
  async send(m) {
    const mail: SentMail = { id: globalThis.crypto.randomUUID(), at: new Date().toISOString(), to: m.to, subject: m.subject, text: m.text, html: m.html, calendar: m.calendar ?? null };
    await kv.set('mail', `${mail.at}|${mail.id}`, mail);
    const all = await kv.values<SentMail>('mail');
    if (all.length > KEEP) {
      const old = all.sort((a, b) => a.at.localeCompare(b.at)).slice(0, all.length - KEEP);
      await Promise.all(old.map((o) => kv.delete('mail', `${o.at}|${o.id}`)));
    }
  },
};

export const sentMail = async (): Promise<SentMail[]> => (await kv.values<SentMail>('mail')).sort((a, b) => b.at.localeCompare(a.at));
