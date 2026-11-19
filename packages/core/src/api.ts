/**
 * HTTP contracts shared by the services (request validation) and the web app
 * (typed client). One definition per shape — nothing is re-declared elsewhere.
 */
import { z } from 'zod';
import { durationSchema, isoDateSchema, type Duration, type IsoDate } from './duration.js';
import { fieldKeySchema } from './fields.js';
import type { AccessLevel, Grant, GrantLevel, Principal } from './permissions.js';
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

export interface PurchaseClass {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string;
  archived: boolean;
}

export const purchaseClassInputSchema = z.object({
  key: fieldKeySchema,
  name: z.string().min(1).max(80),
  description: z.string().max(400).nullable().default(null),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
  archived: z.boolean().default(false),
});
export type PurchaseClassInput = z.infer<typeof purchaseClassInputSchema>;

export interface GrantRecord extends Grant {
  id: string;
  principalType: 'user' | 'group';
  principalId: string;
  principalName: string;
}

export const grantInputSchema = z.object({
  principalType: z.enum(['user', 'group']),
  principalId: uuid,
  purchaseClassId: uuid.nullable(),
  assetTypeId: uuid.nullable(),
  level: z.enum(['view', 'edit', 'manage']),
});
export type GrantInput = z.infer<typeof grantInputSchema>;

// ─── Registry ──────────────────────────────────────────────────────────────

export interface Asset {
  id: string;
  assetTypeId: string;
  typeVersion: number;
  name: string;
  status: string;
  ownerId: string | null;
  purchaseClassId: string;
  attributes: Attributes;
  reminderOverrides: Record<string, Duration[]>;
  /** The caller's effective access to this asset. */
  access: AccessLevel;
  createdAt: string;
  updatedAt: string;
}

const attributesInput = z.record(z.string(), z.unknown());
const reminderOverridesSchema = z.record(fieldKeySchema, z.array(durationSchema).max(10));

export const assetCreateSchema = z.object({
  assetTypeId: uuid,
  name: z.string().min(1).max(200),
  status: fieldKeySchema.optional(),
  ownerId: uuid.nullable().default(null),
  purchaseClassId: uuid,
  attributes: attributesInput.default({}),
  reminderOverrides: reminderOverridesSchema.default({}),
});
export type AssetCreate = z.infer<typeof assetCreateSchema>;

export const assetUpdateSchema = z
  .object({
    name: z.string().min(1).max(200),
    status: fieldKeySchema,
    ownerId: uuid.nullable(),
    purchaseClassId: uuid,
    attributes: attributesInput,
    reminderOverrides: reminderOverridesSchema,
  })
  .partial();
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;

export const assetQuerySchema = pageQuerySchema.extend({
  assetTypeId: uuid.optional(),
  purchaseClassId: uuid.optional(),
  status: z.string().optional(),
  ownerId: uuid.optional(),
  q: z.string().max(200).optional(),
  sort: z.string().max(60).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type AssetQuery = z.infer<typeof assetQuerySchema>;

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
  purchaseClassId: string;
  level: AccessLevel;
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
  purchaseClassId: string;
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
}

export const obligationQuerySchema = pageQuerySchema.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  state: z.enum(['active', 'open', 'snoozed', 'done', 'dismissed', 'all']).default('active'),
  assetId: uuid.optional(),
  dateKindId: uuid.optional(),
  mine: z.coerce.boolean().default(false),
});
export type ObligationQuery = z.infer<typeof obligationQuerySchema>;

export const obligationActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('complete'), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal('dismiss'), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal('snooze'), until: isoDateSchema }),
  z.object({ action: z.literal('reopen') }),
]);
export type ObligationAction = z.infer<typeof obligationActionSchema>;

export interface ObligationSummary {
  overdue: number;
  dueThisWeek: number;
  dueThisMonth: number;
  spend: Array<{ currency: string; next30: number; next90: number }>;
}

export type { GrantLevel };
