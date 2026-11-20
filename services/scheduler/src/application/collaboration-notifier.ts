import { renewalDecisionMeta, type AssetCommented, type RenewalCheckChanged } from '@am/core';
import type { Logger } from 'pino';
import { commentMessage, renewalCheckMessage, type Message } from '../domain/messages.js';
import { notificationsSent } from './metrics.js';
import type { Clock, Mailer, SchedulerStore, UserRef } from './ports.js';

type Recipient = { email: string; name: string };

/**
 * Emails that keep owners and buyers talking:
 *  - renewal check asked    → the owner (or the unit's nearest managers when nobody owns it)
 *  - renewal check answered → whoever asked (or the request inbox, e.g. procurement@, when the owner spoke first)
 *  - conversation message   → people @mentioned, and the owner
 * Never the person who acted. Failures are retried by the event bus.
 */
export class CollaborationNotifier {
  constructor(
    private readonly store: SchedulerStore,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly appUrl: string,
    private readonly inbox: string[],
  ) {}

  async onRenewalCheck(e: RenewalCheckChanged): Promise<void> {
    const people = new Set<string>();
    const emails: string[] = [];
    if (e.kind === 'asked') {
      if (e.ownerId) people.add(e.ownerId);
      else {
        const path = (await this.store.unitPaths([e.unitId])).get(e.unitId) ?? [e.unitId];
        (await this.store.nearestManagers(path)).forEach((id) => people.add(id));
      }
    } else if (e.askedById && e.askedById !== e.actorId) {
      people.add(e.askedById);
    } else {
      emails.push(...this.inbox);
    }
    if (e.actorId) people.delete(e.actorId);

    const notice = {
      assetName: e.assetName,
      label: e.label,
      dueDate: e.dueDate,
      kind: e.kind,
      decisionLabel: renewalDecisionMeta[e.status].label,
      actorName: e.actorName,
      text: e.text,
      url: `${this.appUrl}/assets/${e.assetId}?check=${e.obligationId}`,
    };
    const today = this.clock.today();
    await this.deliver('renewal_check', await this.recipients(people, emails), (name) => renewalCheckMessage(notice, name, today));
  }

  async onAssetCommented(e: AssetCommented): Promise<void> {
    const mentioned = new Set(e.mentionIds);
    const people = new Set([...e.mentionIds, ...(e.ownerId ? [e.ownerId] : [])]);
    people.delete(e.authorId);
    const users = await this.store.users([...people]);
    const url = `${this.appUrl}/assets/${e.assetId}#conversation`;
    for (const id of people) {
      const r = usable(users.get(id));
      if (!r) continue;
      await this.deliver('comment_email', [r], (name) => commentMessage({ assetName: e.assetName, authorName: e.authorName, excerpt: e.excerpt, mentioned: mentioned.has(id), url }, name));
    }
  }

  private async recipients(people: Set<string>, emails: string[]): Promise<Recipient[]> {
    const users = await this.store.users([...people]);
    const list = [...[...users.values()].flatMap((u) => usable(u) ?? []), ...emails.map((email) => ({ email, name: email.split('@')[0]! }))];
    return [...new Map(list.map((r) => [r.email.toLowerCase(), r])).values()];
  }

  private async deliver(channel: string, recipients: Recipient[], build: (name: string) => Message) {
    for (const r of recipients) {
      try {
        await this.mailer.send({ to: r.email, ...build(r.name) });
        notificationsSent.inc({ channel, outcome: 'sent' });
      } catch (err) {
        notificationsSent.inc({ channel, outcome: 'failed' });
        this.logger.error({ err, to: r.email }, `${channel} failed`);
        throw err;
      }
    }
  }
}

/** Active people with an email who have not turned email notifications off. */
const usable = (u: UserRef | undefined): Recipient | null => (u?.active && u.email && u.emailReminders ? { email: u.email, name: u.displayName } : null);
