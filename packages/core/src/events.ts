/**
 * Integration events. Producers write them to their outbox in the same
 * transaction as the state change; consumers keep local read projections, so
 * no service reads another service's tables or calls it synchronously to
 * authorise a request.
 */
import type { IsoDate } from './duration.js';
import type { TrackedDate } from './tracking.js';
import type { Permission } from './permissions.js';

export interface AssetChanged {
  assetId: string;
  name: string;
  assetTypeId: string;
  assetTypeName: string;
  unitId: string;
  catalogId: string | null;
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
  /** Directory groups the person is in (catalogs can be shared with groups). */
  groupIds: string[];
}

/** A directory group appeared or was renamed (names for sharing screens). */
export interface GroupChanged {
  groupId: string;
  name: string;
  source: string;
  memberCount: number;
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

/** Full state of a catalog's sharing (consumers replace what they hold). */
export interface CatalogChanged {
  catalogId: string;
  unitId: string;
  name: string;
  deleted: boolean;
  /** "unit:<id>" / "user:<id>" → level. */
  shares: Array<{ subjectKey: string; permissions: Permission[] }>;
  version: number;
}

export interface AssetCommented {
  assetId: string;
  assetName: string;
  commentId: string;
  authorId: string;
  authorName: string;
  /** Plain text, trimmed for notifications. */
  excerpt: string;
  mentionIds: string[];
  ownerId: string | null;
}

/** A renewal check was asked or answered (emails, and a line in the asset's conversation). */
export interface RenewalCheckChanged {
  obligationId: string;
  assetId: string;
  assetName: string;
  label: string;
  dueDate: IsoDate;
  kind: 'asked' | 'answered';
  /** 'asked' or the owner's decision. */
  status: 'asked' | 'renew' | 'change' | 'cancel';
  /** Null when the scheduler asked automatically. */
  actorId: string | null;
  actorName: string;
  /** The question or the answer's note. */
  text: string | null;
  askedById: string | null;
  ownerId: string | null;
  unitId: string;
  at: string;
}

export interface EventMap {
  'unit.changed': UnitChanged;
  'request.changed': RequestChanged;
  'asset.changed': AssetChanged;
  'asset.deleted': AssetDeleted;
  'user.changed': UserChanged;
  'group.changed': GroupChanged;
  'catalog.changed': CatalogChanged;
  'asset.commented': AssetCommented;
  'renewal.check': RenewalCheckChanged;
}

export type EventName = keyof EventMap;
