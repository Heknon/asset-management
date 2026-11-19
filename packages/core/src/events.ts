/**
 * Integration events. Producers write them to their outbox in the same
 * transaction as the state change; consumers keep local read projections, so
 * no service reads another service's tables or calls it synchronously to
 * authorise a request.
 */
import type { IsoDate } from './duration.js';
import type { TrackedDate } from './tracking.js';

export interface AssetChanged {
  assetId: string;
  name: string;
  assetTypeId: string;
  assetTypeName: string;
  unitId: string;
  ownerId: string | null;
  status: string;
  /** False when the status is inactive (retired, cancelled): no reminders. */
  active: boolean;
  spend: { amount: number; currency: string } | null;
  trackedDates: TrackedDate[];
  /** Present when a recurring date was rolled forward ("Renewed"). */
  advanced?: {
    fieldKey: string;
    from: IsoDate;
    to: IsoDate;
    by: string;
    /** The advanced field plus every derived date that moved with it; their old occurrences are complete. */
    affected: string[];
  };
  version: number;
}

export interface AssetDeleted {
  assetId: string;
}

export interface UserChanged {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  active: boolean;
  preferences: { emailReminders: boolean; outlookInvites: boolean };
}

export interface UnitChanged {
  unitId: string;
  key: string;
  name: string;
  kind: string;
  parentId: string | null;
  /** Ancestor ids, root first, ending with this unit. */
  path: string[];
  archived: boolean;
  /** Resolved people who manage this unit (directory + manual); reminder fallback. */
  managerIds: string[];
}

export interface RequestChanged {
  requestId: string;
  number: string;
  title: string;
  unitId: string;
  requesterId: string;
  assigneeId: string | null;
  status: string;
  previousStatus: string | null;
  actorId: string;
  actorName: string;
  /** Comment or status note, when the change carried one. */
  note: string | null;
  kind: 'created' | 'status' | 'comment' | 'assigned' | 'fulfilled';
}

export interface EventMap {
  'unit.changed': UnitChanged;
  'request.changed': RequestChanged;
  'asset.changed': AssetChanged;
  'asset.deleted': AssetDeleted;
  'user.changed': UserChanged;
}

export type EventName = keyof EventMap;
