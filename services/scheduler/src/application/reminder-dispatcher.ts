import type { Logger } from 'pino';
import { invite } from '../domain/calendar.js';
import { inviteMessage, reminderDigest, type DigestItem } from '../domain/messages.js';
import { dueReminderSlot, type AssetRef, type ObligationRecord } from '../domain/obligation.js';
import { calendarEntry } from './obligation-service.js';
import type { Clock, Mailer, SchedulerStore, UserRef } from './ports.js';

interface Recipient {
  email: string;
  name: string;
  /** Registered users can opt out per channel; ad-hoc addresses always receive both. */
  wantsEmail: boolean;
  wantsInvites: boolean;
}

/**
 * Sends due reminders (one digest per recipient per run) and keeps Outlook
 * calendars in sync with obligations. Every delivery is recorded under a
 * stable key, so re-runs, retries and multiple replicas never double-send.
 */
export class ReminderDispatcher {
  constructor(
    private readonly store: SchedulerStore,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly appUrl: string,
    private readonly organizer: { name: string; email: string },
  ) {}

  async run(): Promise<{ reminders: number; invites: number }> {
    const reminders = await this.sendReminders();
    const invites = await this.syncInvites();
    return { reminders, invites };
  }

  private async recipientsFor(items: Array<{ obligation: ObligationRecord; asset: AssetRef }>): Promise<(o: ObligationRecord, a: AssetRef) => Recipient[]> {
    const ids = new Set<string>();
    for (const { obligation: o, asset } of items) {
      if (o.notify.owner && asset.ownerId) ids.add(asset.ownerId);
      o.notify.userIds.forEach((id) => ids.add(id));
    }
    const users = await this.store.users([...ids]);
    const fromUser = (u: UserRef | undefined): Recipient[] =>
      u?.active && u.email ? [{ email: u.email, name: u.displayName, wantsEmail: u.emailReminders, wantsInvites: u.outlookInvites }] : [];
    return (o, a) => {
      const list = [
        ...(o.notify.owner && a.ownerId ? fromUser(users.get(a.ownerId)) : []),
        ...o.notify.userIds.flatMap((id) => fromUser(users.get(id))),
        ...o.notify.emails.map((email) => ({ email, name: email.split('@')[0]!, wantsEmail: true, wantsInvites: true })),
      ];
      return [...new Map(list.map((r) => [r.email.toLowerCase(), r])).values()];
    };
  }

  private digestItem(o: ObligationRecord, a: AssetRef): DigestItem {
    return {
      assetName: a.name,
      assetTypeName: a.assetTypeName,
      label: o.label,
      kindName: o.dateKind.name,
      kindColor: o.dateKind.color,
      actionLabel: o.dateKind.actionLabel,
      dueDate: o.dueDate,
      spend: a.spend,
      url: `${this.appUrl}/assets/${a.assetId}`,
    };
  }

  private async sendReminders(): Promise<number> {
    const today = this.clock.today();
    const candidates = await this.store.remindable(today);
    const recipientsOf = await this.recipientsFor(candidates);
    const digests = new Map<string, { recipient: Recipient; items: Array<{ o: ObligationRecord; a: AssetRef; slot: string }> }>();

    for (const { obligation: o, asset: a } of candidates) {
      const slot = dueReminderSlot(o, today);
      if (!slot) continue;
      for (const r of recipientsOf(o, a)) {
        if (!r.wantsEmail || (await this.store.wasDelivered(o.id, r.email, slot))) continue;
        const d = digests.get(r.email) ?? { recipient: r, items: [] };
        d.items.push({ o, a, slot });
        digests.set(r.email, d);
      }
    }

    let sent = 0;
    for (const { recipient, items } of digests.values()) {
      const message = reminderDigest(recipient.name, items.map((i) => this.digestItem(i.o, i.a)), today, this.appUrl);
      try {
        await this.mailer.send({ to: recipient.email, ...message });
        for (const i of items) await this.store.recordDelivery(i.o.id, recipient.email, i.slot);
        sent++;
      } catch (err) {
        this.logger.error({ err, to: recipient.email }, 'reminder email failed; will retry next run');
      }
    }
    return sent;
  }

  private async syncInvites(): Promise<number> {
    const pending = await this.store.pendingInvites(200);
    const recipientsOf = await this.recipientsFor(pending);
    let sent = 0;
    for (const { obligation: o, asset: a, recipients: previous } of pending) {
      const entry = calendarEntry(o, a, this.appUrl, !a.active);
      const current = entry.status === 'CANCELLED' ? [] : recipientsOf(o, a).filter((r) => r.wantsInvites);
      const currentEmails = new Set(current.map((r) => r.email.toLowerCase()));
      // People who were invited before but are no longer recipients get a cancellation.
      const removed = previous.filter((p) => !currentEmails.has(p.email.toLowerCase()) && p.sentSequence !== null);
      let ok = true;
      const deliver = async (email: string, cancelled: boolean) => {
        const e = cancelled ? { ...entry, status: 'CANCELLED' as const } : entry;
        try {
          await this.mailer.send({ to: email, ...inviteMessage(this.digestItem(o, a), cancelled), calendar: invite(e, this.organizer, email) });
          await this.store.recordInvite(o.id, email, o.sequence, cancelled);
          sent++;
        } catch (err) {
          ok = false;
          this.logger.error({ err, to: email }, 'calendar invite failed; will retry next run');
        }
      };
      for (const r of current) await deliver(r.email, false);
      for (const p of removed) await deliver(p.email, true);
      if (ok) await this.store.markInvitesSynced(o.id, o.sequence);
    }
    return sent;
  }
}
