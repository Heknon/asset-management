import type { AssetChanged, TrackedDate } from '@am/core';
import { describe, expect, it } from 'bun:test';
import { feed, invite } from './calendar.js';
import { commentMessage, reminderDigest, renewalCheckMessage, requestMessage } from './messages.js';
import { confirmOn, dueReminderSlot, needsAutoAsk, nextReminderDate, reconcile, todayIn, urgencyOf, type ObligationRecord } from './obligation.js';

const kind = { id: 'k1', key: 'renewal', name: 'Renewal', color: '#6366f1', behavior: 'recurring' as const, actionLabel: 'Renew' };
const tracked = (over: Partial<TrackedDate> = {}): TrackedDate => ({
  fieldKey: 'renewal_date',
  label: 'Renewal date',
  date: '2027-02-01',
  derived: false,
  dateKind: kind,
  recurrence: { amount: 1, unit: 'year' },
  reminders: [{ amount: 30, unit: 'day' }, { amount: 7, unit: 'day' }],
  notify: { owner: true, userIds: [], emails: [], unitManagers: 'fallback' },
  confirmBefore: null,
  ...over,
});
const event = (dates: TrackedDate[], over: Partial<AssetChanged> = {}): AssetChanged => ({
  assetId: 'a1',
  name: 'Figma',
  assetTypeId: 't1',
  assetTypeName: 'License',
  unitId: 'p1',
  catalogId: null,
  ownerId: 'u1',
  status: 'active',
  active: true,
  spend: null,
  trackedDates: dates,
  version: 2,
  ...over,
});
const obligation = (over: Partial<ObligationRecord> = {}): ObligationRecord => {
  const t = tracked();
  return {
    id: 'o1',
    assetId: 'a1',
    fieldKey: t.fieldKey,
    label: t.label,
    dateKind: t.dateKind,
    dueDate: t.date,
    recurring: true,
    reminders: t.reminders,
    notify: t.notify,
    state: 'open',
    snoozedUntil: null,
    sequence: 0,
    resolvedAt: null,
    resolvedBy: null,
    note: null,
    confirmBefore: null,
    check: null,
    ...over,
  };
};

describe('reconcile', () => {
  it('creates obligations for new tracked dates and skips informational ones', () => {
    const info = tracked({ fieldKey: 'start', dateKind: { ...kind, behavior: 'informational' } });
    expect(reconcile([], event([tracked(), info]))).toEqual([{ kind: 'create', tracked: tracked() }]);
  });

  it('is a no-op when nothing changed (idempotent re-delivery)', () => {
    expect(reconcile([obligation()], event([tracked()]))).toEqual([]);
    // Completed or dismissed earlier: an unrelated edit does not bring it back; a new date does.
    const t = tracked();
    expect(reconcile([], event([t]), [{ fieldKey: t.fieldKey, dueDate: t.date }])).toEqual([]);
    expect(reconcile([], event([{ ...t, date: '2028-01-01' }]), [{ fieldKey: t.fieldKey, dueDate: t.date }])).toHaveLength(1);
  });

  it('moves the same obligation when the date is edited', () => {
    const t = tracked({ date: '2027-03-01' });
    expect(reconcile([obligation()], event([t]))).toEqual([{ kind: 'update', id: 'o1', tracked: t, dateChanged: true }]);
  });

  it('closes the occurrence and opens the next one when advanced', () => {
    const next = tracked({ date: '2028-02-01' });
    const notice = tracked({ fieldKey: 'notice', label: 'Notice', date: '2028-01-02' });
    const oldNotice = obligation({ id: 'o2', fieldKey: 'notice', label: 'Notice', dueDate: '2027-01-02' });
    const advanced = { fieldKey: 'renewal_date', from: '2027-02-01', to: '2028-02-01', by: 'u9', affected: ['renewal_date', 'notice'] };
    const actions = reconcile([obligation(), oldNotice], event([next, notice], { advanced }));
    expect(actions).toEqual([
      { kind: 'resolve', id: 'o1', state: 'done', by: 'u9' },
      { kind: 'create', tracked: next },
      { kind: 'resolve', id: 'o2', state: 'done', by: 'u9' },
      { kind: 'create', tracked: notice },
    ]);
  });

  it('supersedes obligations when the date is cleared or the asset is retired', () => {
    expect(reconcile([obligation()], event([]))).toEqual([{ kind: 'resolve', id: 'o1', state: 'superseded', by: null }]);
    expect(reconcile([obligation()], event([tracked()], { active: false }))).toEqual([{ kind: 'resolve', id: 'o1', state: 'superseded', by: null }]);
  });
});

describe('reminder slots', () => {
  const o = obligation();
  it('fires only the latest passed offset', () => {
    expect(dueReminderSlot(o, '2026-12-01')).toBeNull();
    expect(dueReminderSlot(o, '2027-01-02')).toBe('before:2027-01-02');
    expect(dueReminderSlot(o, '2027-01-28')).toBe('before:2027-01-25');
    expect(dueReminderSlot(o, '2027-02-01')).toBe('due:2027-02-01');
  });

  it('nudges weekly while overdue', () => {
    expect(dueReminderSlot(o, '2027-02-05')).toBe('overdue:2027-02-01');
    expect(dueReminderSlot(o, '2027-02-09')).toBe('overdue:2027-02-08');
  });

  it('respects snoozes', () => {
    const s = obligation({ state: 'snoozed', snoozedUntil: '2027-01-30' });
    expect(dueReminderSlot(s, '2027-01-28')).toBeNull();
    expect(dueReminderSlot(s, '2027-01-30')).toBe('snooze:2027-01-30');
    expect(nextReminderDate(s, '2027-01-28')).toBe('2027-01-30');
    // After the snooze: the due day and the weekly nudges come back, nothing from before it.
    expect(dueReminderSlot(s, '2027-01-31')).toBeNull();
    expect(dueReminderSlot(s, '2027-02-01')).toBe('due:2027-02-01');
    expect(dueReminderSlot(s, '2027-02-09')).toBe('overdue:2027-02-08');
    expect(nextReminderDate(s, '2027-01-31')).toBe('2027-02-01');
  });

  it('computes urgency and next reminder', () => {
    expect(urgencyOf('2027-02-01', '2027-02-02')).toBe('overdue');
    expect(urgencyOf('2027-02-01', '2027-01-28')).toBe('due_soon');
    expect(nextReminderDate(o, '2027-01-05')).toBe('2027-01-25');
  });

  it('derives today in the configured timezone', () => {
    const instant = new Date('2027-01-01T03:00:00Z');
    expect(todayIn('UTC', instant)).toBe('2027-01-01');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-12-31');
  });
});

describe('calendar', () => {
  const entry = { uid: 'o1@assets.example', sequence: 3, date: '2027-02-01', summary: 'Renewal: Figma, Inc; "Enterprise"', description: 'Renew', url: 'https://assets.example/assets/a1', alarm: { amount: 7, unit: 'day' as const }, status: 'CONFIRMED' as const };

  it('produces an Outlook-compatible all-day invite', () => {
    const { method, content } = invite(entry, { name: 'Assets', email: 'assets@example.com' }, 'owner@example.com', new Date('2026-11-19T00:00:00Z'));
    expect(method).toBe('REQUEST');
    expect(content).toContain('METHOD:REQUEST');
    expect(content).toContain('UID:o1@assets.example');
    expect(content).toContain('SEQUENCE:3');
    expect(content).toContain('DTSTART;VALUE=DATE:20270201');
    expect(content).toContain('DTEND;VALUE=DATE:20270202');
    expect(content).toContain('SUMMARY:Renewal: Figma\\, Inc\\; "Enterprise"');
    expect(content).toContain('TRIGGER:-P7D');
    expect(content.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });

  it('cancels by UID', () => {
    const { method, content } = invite({ ...entry, status: 'CANCELLED' }, { name: 'A', email: 'a@x.io' }, 'b@x.io');
    expect(method).toBe('CANCEL');
    expect(content).toContain('STATUS:CANCELLED');
    expect(content).not.toContain('VALARM');
  });

  it('builds a subscription feed', () => {
    expect(feed('Obligations', [entry])).toContain('METHOD:PUBLISH');
  });
});

describe('messages', () => {
  it('escapes user content in the digest', () => {
    const m = reminderDigest('Dana', [{ assetName: '<script>x</script>', assetTypeName: 'License', label: 'Renewal', kindName: 'Renewal', kindColor: '#6366f1', actionLabel: 'Renew', dueDate: '2027-02-01', spend: { amount: 1200, currency: 'USD' }, url: 'https://a/assets/1' }], '2027-01-25', 'https://a');
    expect(m.subject).toBe('Renewal: <script>x</script> — due in 7 days');
    expect(m.html).not.toContain('<script>x');
    expect(m.text).toContain('$1,200');
  });
});

describe('request emails', () => {
  it('describes status changes in plain words and escapes notes', () => {
    const m = requestMessage({ number: 'REQ-1001', title: 'Miro seats', status: 'rejected', statusLabel: 'Declined', requestKind: 'purchase', actorName: 'Dana', note: '<b>Use FigJam</b>', kind: 'status', url: 'https://a/requests/1' }, 'Tom');
    expect(m.subject).toBe('REQ-1001 is now “Declined”: Miro seats');
    expect(m.html).toContain('&lt;b&gt;Use FigJam');
    expect(m.text).toContain('Use FigJam');
  });
});

describe('renewal checks', () => {
  const sixtyDays = { amount: 60, unit: 'day' as const };

  it('asks the owner once the window opens, and never after the date', () => {
    const o = obligation({ confirmBefore: sixtyDays });
    expect(confirmOn(o)).toBe('2026-12-03');
    expect(needsAutoAsk(o, '2026-12-02')).toBe(false);
    expect(needsAutoAsk(o, '2026-12-03')).toBe(true);
    expect(needsAutoAsk(o, '2027-02-02')).toBe(false);
  });

  it('does not ask twice, or for one-off dates', () => {
    const asked = { status: 'asked' as const, askedAt: new Date(), askedById: null, askedByName: 'x', message: null, answeredAt: null, answeredById: null, answeredByName: null, note: null };
    expect(confirmOn(obligation({ confirmBefore: sixtyDays, check: asked }))).toBeNull();
    expect(confirmOn(obligation({ confirmBefore: sixtyDays, recurring: false }))).toBeNull();
    expect(confirmOn(obligation())).toBeNull();
  });

  it('re-syncs an obligation when the setting changes', () => {
    const actions = reconcile([obligation()], event([tracked({ confirmBefore: sixtyDays })]));
    expect(actions).toEqual([expect.objectContaining({ kind: 'update', id: 'o1', dateChanged: false })]);
  });

  it('writes plain, escaped emails', () => {
    const ask = renewalCheckMessage(
      { assetName: 'Figma <Org>', label: 'Renewal date', dueDate: '2027-02-01', kind: 'asked', decisionLabel: 'Waiting for owner', actorName: 'Dana', text: 'Still 40 seats?', url: 'https://x/a' },
      'Tom',
      '2027-01-02',
    );
    expect(ask.subject).toBe('Do you still need Figma <Org>? Renewal date due in 30 days');
    expect(ask.html).toContain('Figma &lt;Org&gt;');
    expect(ask.text).toContain('Still 40 seats?');
    const c = commentMessage({ assetName: 'Figma', authorName: 'Dana', excerpt: 'hi', mentioned: true, url: 'https://x' }, 'Tom');
    expect(c.subject).toBe('Dana mentioned you on Figma');
  });
});
