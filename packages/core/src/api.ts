/**
 * HTTP contracts shared by the services (request validation) and the web app
 * (typed client). One definition per shape — nothing is re-declared elsewhere.
 */
import { z } from 'zod';
import { durationSchema, isoDateSchema, type Duration, type IsoDate } from './duration.js';
import { fieldKeySchema } from './fields.js';
import { accessSchema, roleKeys, subjectKinds, type Grant, type Permission, type Principal, type RoleKey, type SubjectKind, type UnitRole } from './permissions.js';
import type { Attributes } from './attributes.js';
import type { DateBehavior } from './date-kinds.js';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const uuid = z.string().uuid();

// ─── Identity ──────────────────────────────────────────────────────────────

export type AuthSource = 'local' | 'ldap' | 'oidc';

export interface AuthProviderInfo {
  id: AuthSource;
  label: string;
  /** `password` providers render a form; `redirect` providers render a button. */
  flow: 'password' | 'redirect';
}

export const passwordLoginSchema = z.object({
  provider: z.enum(['local', 'ldap']),
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});
export type PasswordLogin = z.infer<typeof passwordLoginSchema>;

export interface Preferences {
  emailReminders: boolean;
  outlookInvites: boolean;
}
export const preferencesSchema = z.object({ emailReminders: z.boolean(), outlookInvites: z.boolean() }).partial();

export interface Me extends Principal {
  preferences: Preferences;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
}

export interface User extends UserSummary {
  source: AuthSource;
  isAdmin: boolean;
  active: boolean;
  lastLoginAt: string | null;
  groups: Array<{ id: string; name: string }>;
}

export const userUpdateSchema = z.object({ isAdmin: z.boolean(), active: z.boolean() }).partial();

/** Local accounts, for people outside the directory (contractors, service desks). */
export const localUserCreateSchema = z.object({
  username: z.string().trim().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dots, dashes and underscores'),
  displayName: z.string().trim().min(1).max(120),
  email: z.string().email().nullable().default(null),
  password: z.string().min(12).max(256),
  isAdmin: z.boolean().default(false),
});
export type LocalUserCreate = z.infer<typeof localUserCreateSchema>;

export interface Group {
  id: string;
  name: string;
  /** LDAP group DN or ADFS group claim value; null for local groups. */
  externalId: string | null;
  source: AuthSource;
  memberCount: number;
}

export const groupInputSchema = z.object({
  name: z.string().min(1).max(120),
  externalId: z.string().max(512).nullable().default(null),
});

// ─── Organization ──────────────────────────────────────────────────────────

/** The role unit members get on the unit's own assets and requests ("none": membership only). */
export const memberRoles = ['none', ...roleKeys.filter((r) => r !== 'admin')] as const;
export type MemberRole = 'none' | Exclude<RoleKey, 'admin'>;

export interface OrgUnit {
  id: string;
  key: string;
  name: string;
  /** Free label for the level: Company, Division, Department, Team, Squad… */
  kind: string;
  description: string | null;
  parentId: string | null;
  /** Ancestor ids, root first, ending with this unit. */
  path: string[];
  color: string;
  /** Unit managers are always Admins of the unit. */
  memberRole: MemberRole;
  /** Directory identifiers whose people are members: group DNs, ADFS group names, or `attribute=value`. */
  directoryMembers: string[];
  directoryManagers: string[];
  archived: boolean;
  memberCount: number;
  managerCount: number;
}

const directoryIds = z.array(z.string().trim().min(1).max(512)).max(50).default([]);

export const orgUnitInputSchema = z.object({
  key: fieldKeySchema,
  name: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(40).default('Team'),
  description: z.string().max(400).nullable().default(null),
  parentId: uuid.nullable().default(null),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
  memberRole: z.enum(memberRoles).default('commenter'),
  directoryMembers: directoryIds,
  directoryManagers: directoryIds,
  archived: z.boolean().default(false),
});
export type OrgUnitInput = z.infer<typeof orgUnitInputSchema>;

/**
 * Bulk import, one unit per line, e.g.
 *   Wix / R&D / Editor / Platform team | CN=editor-platform,OU=Groups,DC=wix,DC=com
 * Missing parents are created; existing units are matched by path and updated.
 */
export const orgImportSchema = z.object({
  text: z.string().min(1).max(500_000),
  kinds: z.array(z.string().min(1).max(40)).max(10).default(['Company', 'Division', 'Department', 'Team']),
});
export type OrgImport = z.infer<typeof orgImportSchema>;

export interface OrgImportResult {
  created: number;
  updated: number;
  errors: Array<{ line: number; message: string }>;
}

export interface UnitPerson extends UserSummary {
  role: UnitRole;
  source: 'manual' | 'directory';
}

export const unitPeopleSchema = z.object({
  members: z.array(uuid).max(5000),
  managers: z.array(uuid).max(500),
});

/** Someone access is given to. Units include everyone in the units beneath them. */
export interface Subject {
  kind: SubjectKind;
  id: string;
  name: string;
  /** "LDAP group · 34 people", "Division · Wix › R&D", an email… */
  detail: string | null;
}

export const subjectInputSchema = z.object({ kind: z.enum(subjectKinds), id: uuid });

/** Access on an organization unit (with everything beneath it) or, with unitId null, the whole organization. */
export interface GrantRecord extends Grant {
  id: string;
  subject: Subject;
  createdByName: string | null;
  createdAt: string;
}

export const grantInputSchema = z.object({
  subject: subjectInputSchema,
  unitId: uuid.nullable(),
  /** Only items of this type (optional). */
  assetTypeId: uuid.nullable().default(null),
  access: accessSchema,
});
export type GrantInput = z.infer<typeof grantInputSchema>;

/** Changing who has which role on a grant or share. */
export const accessUpdateSchema = z.object({ access: accessSchema });

/**
 * Everything that gives access to a unit, for the access screen: explicit
 * grants on it, and what comes from above (ancestors, the whole organization)
 * or from membership.
 */
export interface UnitAccess {
  unitId: string;
  direct: GrantRecord[];
  inherited: Array<GrantRecord & { fromUnitId: string | null }>;
  memberRole: MemberRole;
  managers: Array<{ id: string; displayName: string }>;
  /** The caller may change this unit's access. */
  canManage: boolean;
}

export const subjectSearchSchema = z.object({ q: z.string().trim().min(1).max(100), kinds: z.string().optional() });

// ─── Registry ──────────────────────────────────────────────────────────────

export interface Asset {
  id: string;
  /** Human ID, e.g. "LIC-42". */
  reference: string;
  assetTypeId: string;
  /** The team variant of the template this item follows (its extra fields), if any. */
  variantId: string | null;
  typeVersion: number;
  name: string;
  status: string;
  ownerId: string | null;
  unitId: string;
  /** The catalog this asset is filed in (its owners can share a catalog with other units). */
  catalogId: string | null;
  attributes: Attributes;
  reminderOverrides: Record<string, Duration[]>;
  /** What the caller may do with this asset (org grants and catalog shares combined). */
  permissions: Permission[];
  createdAt: string;
  updatedAt: string;
  /** When searching: where the query matched, with «highlights». */
  snippet?: string;
}

const attributesInput = z.record(z.string(), z.unknown());
const reminderOverridesSchema = z.record(fieldKeySchema, z.array(durationSchema).max(10));

export const assetCreateSchema = z.object({
  assetTypeId: uuid,
  name: z.string().min(1).max(200),
  status: fieldKeySchema.optional(),
  ownerId: uuid.nullable().default(null),
  unitId: uuid,
  variantId: uuid.nullable().default(null),
  catalogId: uuid.nullable().default(null),
  /** The request this asset fulfils, if any. */
  requestId: uuid.optional(),
  attributes: attributesInput.default({}),
  reminderOverrides: reminderOverridesSchema.default({}),
});
export type AssetCreate = z.infer<typeof assetCreateSchema>;

export const assetUpdateSchema = z
  .object({
    name: z.string().min(1).max(200),
    status: fieldKeySchema,
    ownerId: uuid.nullable(),
    unitId: uuid,
    variantId: uuid.nullable(),
    catalogId: uuid.nullable(),
    attributes: attributesInput,
    reminderOverrides: reminderOverridesSchema,
  })
  .partial();
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;

/** Query-string booleans: only "true"/"1" are true (z.coerce.boolean treats "false" as true). */
const queryBool = (fallback: boolean) =>
  z.preprocess((v) => (v === undefined || v === '' ? fallback : v === true || v === 'true' || v === '1'), z.boolean());

export const filterOps = ['contains', 'equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'between', 'isEmpty', 'isNotEmpty', 'in'] as const;
export type FilterOp = (typeof filterOps)[number];

/**
 * A filter on any field. `field` is a system field (name, status, ownerId,
 * assetTypeId, createdAt, updatedAt) or `attributes.<key>`.
 */
export const assetFilterSchema = z.object({
  field: z.string().regex(/^(name|status|ownerId|assetTypeId|createdAt|updatedAt|attributes\.[a-z][a-z0-9_]*)$/),
  op: z.enum(filterOps),
  value: z.unknown().optional(),
});
export type AssetFilter = z.infer<typeof assetFilterSchema>;

const jsonParam = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }, schema);

export const assetQuerySchema = pageQuerySchema.extend({
  assetTypeId: uuid.optional(),
  unitId: uuid.optional(),
  /** With a unit: include everything beneath it (default) or only the unit itself. */
  includeSubunits: queryBool(true),
  status: z.string().optional(),
  ownerId: uuid.optional(),
  catalogId: uuid.optional(),
  variantId: uuid.optional(),
  q: z.string().max(200).optional(),
  filters: jsonParam(z.array(assetFilterSchema).max(20)).default([]),
  sort: z.string().max(60).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type AssetQuery = z.infer<typeof assetQuerySchema>;

/** CSV export: the same query as the table (filters, search, sort), every page. */
export const assetExportSchema = assetQuerySchema.omit({ limit: true, offset: true });
export type AssetExportQuery = z.infer<typeof assetExportSchema>;
/** Exports stop here; narrow the filters for more. */
export const EXPORT_ROW_LIMIT = 50_000;

// ─── Catalogs & sharing ────────────────────────────────────────────────────

/**
 * A named collection of a unit's assets ("R&D Labs", "Design licenses") that
 * the unit can share with other units, divisions or people. Each asset is in
 * at most one catalog; the catalog belongs to the asset's unit or an ancestor.
 */
export interface Catalog {
  id: string;
  unitId: string;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  assetCount: number;
  /** What the caller may do here (through the org tree, a share, or both). */
  permissions: Permission[];
  /** True when the caller reaches it through a share rather than the org tree. */
  sharedWithMe: boolean;
  shares: CatalogShare[];
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogShare {
  subject: Subject;
  permissions: Permission[];
  createdByName: string;
  createdAt: string;
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const catalogInputSchema = z.object({
  unitId: uuid,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().default(null),
  icon: z.string().min(1).max(40).default('folder'),
  color: hexColor.default('#6366f1'),
});
export type CatalogInput = z.infer<typeof catalogInputSchema>;

export const catalogShareInputSchema = z.object({
  subject: subjectInputSchema,
  access: accessSchema,
});
export type CatalogShareInput = z.infer<typeof catalogShareInputSchema>;

export const catalogQuerySchema = z.object({
  /** Catalogs owned by this unit (and beneath it). */
  unitId: uuid.optional(),
  /** "shared": only catalogs shared with me; "owned": only my org tree's; "all" (default). */
  scope: z.enum(['all', 'owned', 'shared']).default('all'),
});
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

// ─── Conversations ─────────────────────────────────────────────────────────

/** A message on an asset's conversation. Anyone who can see the asset can read and post. */
export interface AssetComment {
  id: string;
  assetId: string;
  /** "message" (people), or "renewal_check" (posted when a renewal is asked about / answered). */
  kind: 'message' | 'renewal_check';
  authorId: string;
  authorName: string;
  body: string;
  mentionIds: string[];
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export const commentInputSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  /** People mentioned with @; they are emailed. */
  mentionIds: z.array(uuid).max(20).default([]),
});
export type CommentInput = z.infer<typeof commentInputSchema>;

export interface ActivityEntry {
  id: string;
  assetId: string;
  actorId: string;
  actorName: string;
  action: 'created' | 'updated' | 'deleted' | 'advanced';
  changes: Record<string, { from: unknown; to: unknown }>;
  at: string;
}

export interface AccessCheck {
  assetId: string;
  assetTypeId: string;
  unitId: string;
  catalogId: string | null;
  permissions: Permission[];
}

// ─── Files ─────────────────────────────────────────────────────────────────

export type PreviewKind = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'none';

export interface FileRecord {
  id: string;
  assetId: string;
  filename: string;
  contentType: string;
  size: number;
  status: 'pending' | 'ready';
  preview: PreviewKind;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
}

export const uploadRequestSchema = z.object({
  assetId: uuid,
  filename: z.string().min(1).max(255),
  contentType: z.string().min(3).max(128),
  size: z.number().int().positive(),
});
export type UploadRequest = z.infer<typeof uploadRequestSchema>;

export interface UploadTicket {
  file: FileRecord;
  /** Browser POSTs a multipart form with `fields` + the file directly to S3. */
  upload: { url: string; fields: Record<string, string>; expiresAt: string };
}

export interface SignedUrl {
  url: string;
  expiresAt: string;
}

// ─── Scheduler ─────────────────────────────────────────────────────────────

export type ObligationState = 'open' | 'snoozed' | 'done' | 'dismissed' | 'superseded';
export type Urgency = 'overdue' | 'due_soon' | 'upcoming' | 'later';

export interface Obligation {
  id: string;
  assetId: string;
  assetName: string;
  assetTypeId: string;
  assetTypeName: string;
  unitId: string;
  ownerId: string | null;
  fieldKey: string;
  label: string;
  dateKind: { id: string; key: string; name: string; color: string; behavior: DateBehavior; actionLabel: string };
  dueDate: IsoDate;
  recurring: boolean;
  state: ObligationState;
  urgency: Urgency;
  snoozedUntil: IsoDate | null;
  spend: { amount: number; currency: string } | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  nextReminder: IsoDate | null;
  /** "Do you still need this?": the owner's answer before a renewal. */
  check: RenewalCheck | null;
  /** When the owner is asked automatically (from the date's settings), if not asked yet. */
  confirmOn: IsoDate | null;
}

export const renewalDecisions = ['renew', 'change', 'cancel'] as const;
export type RenewalDecision = (typeof renewalDecisions)[number];

export const renewalDecisionMeta: Record<RenewalDecision | 'asked', { label: string; tone: 'neutral' | 'accent' | 'warning' | 'success' | 'danger' }> = {
  asked: { label: 'Waiting for owner', tone: 'warning' },
  renew: { label: 'Owner: renew', tone: 'success' },
  change: { label: 'Owner: renew with changes', tone: 'accent' },
  cancel: { label: "Owner: don't renew", tone: 'danger' },
};

/**
 * Before paying for a renewal, the people who buy ask the people who use it.
 * One check per occurrence of the date; a new cycle starts unanswered.
 */
export interface RenewalCheck {
  status: 'asked' | RenewalDecision;
  askedAt: string | null;
  askedByName: string | null;
  message: string | null;
  answeredAt: string | null;
  answeredByName: string | null;
  note: string | null;
}

export const obligationQuerySchema = pageQuerySchema.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  state: z.enum(['active', 'open', 'snoozed', 'done', 'dismissed', 'all']).default('active'),
  assetId: uuid.optional(),
  dateKindId: uuid.optional(),
  /** Only items I own or am a named contact for. */
  mine: queryBool(false),
  /** Only items of this unit and everything beneath it. */
  unitId: uuid.optional(),
  /** Renewal checks: waiting for the owner, or answered. */
  check: z.enum(['asked', 'answered']).optional(),
});
export type ObligationQuery = z.infer<typeof obligationQuerySchema>;

export const obligationActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('complete'), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal('dismiss'), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal('snooze'), until: isoDateSchema }),
  z.object({ action: z.literal('reopen') }),
  /** Ask the owner whether this should be renewed (needs edit). */
  z.object({ action: z.literal('ask'), message: z.string().trim().max(1000).optional() }),
  /** The owner's (or anyone who can see it) answer. */
  z.object({ action: z.literal('answer'), decision: z.enum(renewalDecisions), note: z.string().trim().max(2000).optional() }),
]);
export type ObligationAction = z.infer<typeof obligationActionSchema>;

export interface ObligationSummary {
  overdue: number;
  dueThisWeek: number;
  dueThisMonth: number;
  spend: Array<{ currency: string; next30: number; next90: number; next365: number }>;
}

export const summaryQuerySchema = z.object({ unitId: uuid.optional(), mine: queryBool(false) });

/** Per direct child of a unit: what renews beneath it (for division/department pages). */
export interface UnitRollup {
  unitId: string;
  openItems: number;
  overdue: number;
  renewingNext90: number;
  spendNext365: Array<{ currency: string; amount: number }>;
}

// ─── Requests ──────────────────────────────────────────────────────────────

/**
 * Anyone can ask for something on behalf of their team or any unit above it;
 * people with edit access to that unit (e.g. Procurement) handle it.
 */
export const requestStatuses = ['submitted', 'in_review', 'approved', 'ordered', 'fulfilled', 'rejected', 'cancelled'] as const;
export type RequestStatus = (typeof requestStatuses)[number];
export const openRequestStatuses: RequestStatus[] = ['submitted', 'in_review', 'approved', 'ordered'];

export const requestStatusMeta: Record<RequestStatus, { label: string; tone: 'neutral' | 'accent' | 'warning' | 'success' | 'danger' }> = {
  submitted: { label: 'Submitted', tone: 'accent' },
  in_review: { label: 'In review', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  ordered: { label: 'Ordered', tone: 'accent' },
  fulfilled: { label: 'Fulfilled', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** Which status moves are allowed, and who may make them. */
export const requestTransitions: Record<RequestStatus, Partial<Record<RequestStatus, 'handler' | 'requester'>>> = {
  submitted: { in_review: 'handler', approved: 'handler', rejected: 'handler', cancelled: 'requester' },
  in_review: { approved: 'handler', rejected: 'handler', submitted: 'handler', cancelled: 'requester' },
  approved: { ordered: 'handler', rejected: 'handler', cancelled: 'requester' },
  ordered: { approved: 'handler' },
  fulfilled: {},
  rejected: { in_review: 'handler' },
  cancelled: {},
};

export type RequestAccess = 'viewer' | 'requester' | 'handler';

export interface PurchaseRequest {
  id: string;
  /** Human-friendly reference, e.g. REQ-1042. */
  number: string;
  title: string;
  description: string;
  unitId: string;
  assetTypeId: string | null;
  requesterId: string;
  requesterName: string;
  assigneeId: string | null;
  status: RequestStatus;
  quantity: number | null;
  estimatedCost: { amount: number; currency: string } | null;
  neededBy: IsoDate | null;
  link: string | null;
  assetId: string | null;
  createdAt: string;
  updatedAt: string;
  access: RequestAccess;
  commentCount: number;
  snippet?: string;
}

export const requestCreateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().max(4000).default(''),
  unitId: uuid,
  assetTypeId: uuid.nullable().default(null),
  quantity: z.number().int().positive().max(1_000_000).nullable().default(null),
  estimatedCost: z.object({ amount: z.number().min(0).max(1e12), currency: z.string().length(3) }).nullable().default(null),
  neededBy: isoDateSchema.nullable().default(null),
  link: z.string().url().max(2000).nullable().default(null),
});
export type RequestCreate = z.infer<typeof requestCreateSchema>;
export const requestUpdateSchema = requestCreateSchema.partial();
export type RequestUpdate = z.infer<typeof requestUpdateSchema>;

export const requestQuerySchema = pageQuerySchema.extend({
  /** mine: I asked · team: my units' requests · handle: requests I can process · all: everything I can see */
  scope: z.enum(['mine', 'team', 'handle', 'all']).default('mine'),
  status: z.enum(['open', 'closed', 'all', ...requestStatuses]).default('open'),
  unitId: uuid.optional(),
  assigneeId: uuid.optional(),
  q: z.string().max(200).optional(),
});
export type RequestQuery = z.infer<typeof requestQuerySchema>;

export const requestActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('comment'), body: z.string().trim().min(1).max(4000) }),
  z.object({ action: z.literal('status'), status: z.enum(requestStatuses), note: z.string().max(4000).optional() }),
  z.object({ action: z.literal('assign'), assigneeId: uuid.nullable() }),
]);
export type RequestAction = z.infer<typeof requestActionSchema>;

export interface RequestEvent {
  id: string;
  requestId: string;
  actorId: string;
  actorName: string;
  kind: 'created' | 'comment' | 'status' | 'assigned' | 'edited' | 'fulfilled';
  body: string | null;
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus | null;
  at: string;
}

export interface RequestCounts {
  mine: number;
  team: number;
  handle: number;
  unassigned: number;
}

// ─── Search & saved views ──────────────────────────────────────────────────

export type SearchHitKind = 'asset' | 'request' | 'type' | 'unit' | 'person';

export interface SearchHit {
  kind: SearchHitKind;
  id: string;
  title: string;
  subtitle: string | null;
  /** Matching text with «highlighted» terms. */
  snippet: string | null;
  assetTypeId?: string;
  unitId?: string;
}

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(8),
});

export const savedQuerySchema = z.object({
  assetTypeId: uuid.optional(),
  variantId: uuid.optional(),
  unitId: uuid.optional(),
  includeSubunits: z.boolean().optional(),
  status: z.string().optional(),
  ownerId: uuid.optional(),
  q: z.string().max(200).optional(),
  filters: z.array(assetFilterSchema).max(20).optional(),
  sort: z.string().max(60).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type SavedQuery = z.infer<typeof savedQuerySchema>;

export interface SavedView {
  id: string;
  name: string;
  query: SavedQuery;
  pinned: boolean;
  createdAt: string;
}

export const savedViewInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  query: savedQuerySchema,
  pinned: z.boolean().default(true),
});
export type SavedViewInput = z.infer<typeof savedViewInputSchema>;


