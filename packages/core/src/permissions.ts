import { z } from 'zod';

/**
 * Access is granted per (purchase class × asset type). A purchase class is
 * "who/what the purchase is for" (a department, a client, a project); it is the
 * primary security boundary. `null` in a grant means "all".
 *
 * - view:   read assets, their documents and dates
 * - edit:   create/update assets, upload documents, act on reminders
 * - manage: everything above + delete, and see/edit restricted fields
 */
export const accessLevels = ['none', 'view', 'edit', 'manage'] as const;
export type AccessLevel = (typeof accessLevels)[number];
export type GrantLevel = Exclude<AccessLevel, 'none'>;

const rank: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2, manage: 3 };

export const grantSchema = z.object({
  purchaseClassId: z.string().uuid().nullable(),
  assetTypeId: z.string().uuid().nullable(),
  level: z.enum(['view', 'edit', 'manage']),
});
export type Grant = z.infer<typeof grantSchema>;

/** The authenticated caller, as carried in the access token. */
export interface Principal {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  isAdmin: boolean;
  grants: Grant[];
}

export interface AccessScope {
  purchaseClassId: string;
  assetTypeId: string;
}

export function atLeast(level: AccessLevel, required: AccessLevel): boolean {
  return rank[level] >= rank[required];
}

export function maxLevel(a: AccessLevel, b: AccessLevel): AccessLevel {
  return rank[a] >= rank[b] ? a : b;
}

export function effectiveLevel(principal: Pick<Principal, 'isAdmin' | 'grants'>, scope: AccessScope): AccessLevel {
  if (principal.isAdmin) return 'manage';
  let level: AccessLevel = 'none';
  for (const g of principal.grants) {
    const pc = g.purchaseClassId === null || g.purchaseClassId === scope.purchaseClassId;
    const at = g.assetTypeId === null || g.assetTypeId === scope.assetTypeId;
    if (pc && at) level = maxLevel(level, g.level);
  }
  return level;
}

export function can(principal: Pick<Principal, 'isAdmin' | 'grants'>, required: AccessLevel, scope: AccessScope): boolean {
  return atLeast(effectiveLevel(principal, scope), required);
}

/** A (purchase class × asset type) pair where `null` means "any". */
export type Scope = Pick<Grant, 'purchaseClassId' | 'assetTypeId'>;

/**
 * Grants that satisfy `required`, collapsed so repositories can turn them into a
 * WHERE clause. A single `{null, null}` entry means unrestricted.
 */
export function scopesFor(principal: Pick<Principal, 'isAdmin' | 'grants'>, required: AccessLevel): Scope[] {
  if (principal.isAdmin) return [{ purchaseClassId: null, assetTypeId: null }];
  const scopes = principal.grants.filter((g) => atLeast(g.level, required)).map(({ purchaseClassId, assetTypeId }) => ({ purchaseClassId, assetTypeId }));
  return scopes.some((s) => s.purchaseClassId === null && s.assetTypeId === null) ? [{ purchaseClassId: null, assetTypeId: null }] : scopes;
}

/** Combines grants from a user and their groups into the minimal set (highest level per scope). */
export function consolidateGrants(grants: readonly Grant[]): Grant[] {
  const best = new Map<string, Grant>();
  for (const g of grants) {
    const key = `${g.purchaseClassId ?? '*'}|${g.assetTypeId ?? '*'}`;
    const cur = best.get(key);
    if (!cur || rank[g.level] > rank[cur.level]) best.set(key, g);
  }
  return [...best.values()];
}
