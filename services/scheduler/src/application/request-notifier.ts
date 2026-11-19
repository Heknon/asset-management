import type { RequestChanged } from '@am/core';
import type { Logger } from 'pino';
import { requestMessage } from '../domain/messages.js';
import { notificationsSent } from './metrics.js';
import type { Mailer, SchedulerStore } from './ports.js';

/**
 * Emails about requests:
 *  - new request → the request inbox (e.g. procurement@) and the team's nearest managers
 *  - status change / fulfilment → the requester
 *  - comment → the requester and the assignee (never the person who wrote it)
 *  - assignment → the new assignee
 */
export class RequestNotifier {
  constructor(
    private readonly store: SchedulerStore,
    private readonly mailer: Mailer,
    private readonly logger: Logger,
    private readonly appUrl: string,
    private readonly inbox: string[],
  ) {}

  async onRequestChanged(e: RequestChanged): Promise<void> {
    // The renewals list shows where the renewal of each date stands.
    if (e.requestKind === 'renewal' && e.renewal) {
      await this.store.setRenewalRequest(e.renewal, { id: e.requestId, number: e.number, status: e.status, label: e.statusLabel, color: e.statusColor, category: e.statusCategory, at: e.at });
    }
    const people = new Set<string>();
    const emails = new Set<string>();
    if (e.kind === 'created') {
      this.inbox.forEach((m) => emails.add(m.toLowerCase()));
      const unit = (await this.store.unitPaths([e.unitId])).get(e.unitId) ?? [e.unitId];
      (await this.store.nearestManagers(unit)).forEach((id) => people.add(id));
    } else if (e.kind === 'comment') {
      people.add(e.requesterId);
      if (e.assigneeId) people.add(e.assigneeId);
    } else if (e.kind === 'assigned') {
      if (e.assigneeId) people.add(e.assigneeId);
    } else {
      people.add(e.requesterId);
    }
    people.delete(e.actorId);

    const users = await this.store.users([...people]);
    const recipients = [
      ...[...users.values()].filter((u) => u.active && u.email && u.emailReminders).map((u) => ({ email: u.email!, name: u.displayName })),
      ...[...emails].map((email) => ({ email, name: email.split('@')[0]! })),
    ];
    const unique = [...new Map(recipients.map((r) => [r.email.toLowerCase(), r])).values()];
    const notice = { ...e, url: `${this.appUrl}/requests/${e.requestId}` };
    for (const r of unique) {
      try {
        await this.mailer.send({ to: r.email, ...requestMessage(notice, r.name) });
        notificationsSent.inc({ channel: 'request_email', outcome: 'sent' });
      } catch (err) {
        notificationsSent.inc({ channel: 'request_email', outcome: 'failed' });
        this.logger.error({ err, to: r.email }, 'request email failed');
        throw err; // retried by the event bus
      }
    }
  }
}
