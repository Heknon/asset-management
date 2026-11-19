import type { IsoDate, ObligationQuery, Scope, TrackedDate } from '@am/core';
import type { AssetRef, ObligationRecord } from '../domain/obligation.js';

export interface UserRef {
  id: string;
  displayName: string;
  email: string | null;
  active: boolean;
  emailReminders: boolean;
  outlookInvites: boolean;
}

export interface ObligationWithAsset {
  obligation: ObligationRecord;
  asset: AssetRef;
}

export interface SchedulerStore {
  transaction<T>(fn: (store: SchedulerStore) => Promise<T>): Promise<T>;

  /** Returns false (and changes nothing) when the event is older than what we have. */
  upsertAsset(ref: AssetRef, version: number): Promise<boolean>;
  markAssetDeleted(assetId: string): Promise<void>;
  activeObligations(assetId: string, opts?: { forUpdate?: boolean }): Promise<ObligationRecord[]>;
  createObligation(assetId: string, tracked: TrackedDate): Promise<ObligationRecord>;
  updateObligation(id: string, tracked: TrackedDate, dateChanged: boolean): Promise<void>;
  resolveObligation(id: string, state: ObligationRecord['state'], by: string | null, note?: string | null): Promise<void>;
  setSnooze(id: string, until: IsoDate): Promise<void>;
  reopen(id: string): Promise<void>;
  getObligation(id: string): Promise<ObligationWithAsset | null>;

  query(q: ObligationQuery, scopes: Scope[], userId: string): Promise<{ items: ObligationWithAsset[]; total: number }>;
  summary(scopes: Scope[], today: IsoDate): Promise<{ overdue: number; dueThisWeek: number; dueThisMonth: number; spend: Array<{ currency: string; next30: number; next90: number }> }>;

  /** Active obligations of active assets that may need a reminder today. */
  remindable(today: IsoDate): Promise<ObligationWithAsset[]>;
  wasDelivered(obligationId: string, recipient: string, slot: string): Promise<boolean>;
  recordDelivery(obligationId: string, recipient: string, slot: string): Promise<void>;

  /** Obligations whose calendar entry changed since it was last sent (including cancellations). */
  pendingInvites(limit: number): Promise<Array<ObligationWithAsset & { recipients: Array<{ email: string; sentSequence: number | null }> }>>;
  recordInvite(obligationId: string, recipient: string, sequence: number, cancelled: boolean): Promise<void>;
  markInvitesSynced(obligationId: string, sequence: number): Promise<void>;

  /** Obligations a user owns or is a contact for, for their calendar feed. */
  feedFor(userId: string, from: IsoDate): Promise<ObligationWithAsset[]>;

  upsertUser(u: UserRef & { username: string }): Promise<void>;
  users(ids: string[]): Promise<Map<string, UserRef>>;
  calendarToken(userId: string, rotate: boolean): Promise<string>;
  userByCalendarToken(token: string): Promise<UserRef | null>;
}

/** Outbound email; reminders and Outlook invites both go through it. */
export interface Mailer {
  send(message: { to: string; subject: string; text: string; html: string; calendar?: { method: 'REQUEST' | 'CANCEL'; content: string } }): Promise<void>;
}

export interface Clock {
  today(): IsoDate;
}
