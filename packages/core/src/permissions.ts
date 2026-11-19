import { z } from 'zod';

/**
 * Access follows the organization tree. Every asset and request belongs to one
 * organization unit (company, division, department, team…). A grant on a unit
 * applies to that unit and everything beneath it; `null` means "the whole
 * organization" / "every asset type".
 *
 * - view:   read assets, their documents and dates
 * - edit:   create/update assets, upload documents, act on reminders, handle requests
 * - manage: everything above + delete, and see/edit restricted fields
 *
 * Grants come from three places, combined at sign-in:
 *   1. unit membership  → the unit's default member access (usually view)
 *   2. unit management  → manage on the unit's subtree
 *   3. explicit grants  → e.g. Procurement: manage on the whole organization
 */
export const accessLevels = ['none', 'view', 'edit', 'manage'] as const;
export type AccessLevel = (typeof accessLevels)[number];
export type GrantLevel = Exclude<AccessLevel, 'none'>;

const rank: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2, manage: 3 };

export const grantSchema = z.object({
  unitId: z.string().uuid().nullable(),
  assetTypeId: z.string().uuid().nullable(),
  level: z.enum(['view', 'edit', 'manage']),
});
export type Grant = z.infer<typeof grantSchema>;

export type UnitRole = 'member' | 'manager';

/** The authenticated caller, as carried in the access token. */
export interface Principal {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  isAdmin: boolean;
  grants: Grant[];
  /** Units the caller belongs to or manages (direct, not inherited). */
  units: Array<{ unitId: string; role: UnitRole }>;
}

/** Where a resource sits: its unit's ancestor chain (root first, ending with the unit itself). */
export interface AccessScope {
  unitPath: readonly string[];
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
    const unit = g.unitId === null || scope.unitPath.includes(g.unitId);
    const type = g.assetTypeId === null || g.assetTypeId === scope.assetTypeId;
    if (unit && type) level = maxLevel(level, g.level);
  }
  return level;
}

export function can(principal: Pick<Principal, 'isAdmin' | 'grants'>, required: AccessLevel, scope: AccessScope): boolean {
  return atLeast(effectiveLevel(principal, scope), required);
}

/** A (unit subtree × asset type) pair where `null` means "any". */
export type Scope = Pick<Grant, 'unitId' | 'assetTypeId'>;

/**
 * Grants that satisfy `required`, collapsed so repositories can turn them into a
 * WHERE clause. A single `{null, null}` entry means unrestricted.
 */
export function scopesFor(principal: Pick<Principal, 'isAdmin' | 'grants'>, required: AccessLevel): Scope[] {
  if (principal.isAdmin) return [{ unitId: null, assetTypeId: null }];
  const scopes = principal.grants.filter((g) => atLeast(g.level, required)).map(({ unitId, assetTypeId }) => ({ unitId, assetTypeId }));
  return scopes.some((s) => s.unitId === null && s.assetTypeId === null) ? [{ unitId: null, assetTypeId: null }] : scopes;
}

/** Combines grants from every source into the minimal set (highest level per scope). */
export function consolidateGrants(grants: readonly Grant[]): Grant[] {
  const best = new Map<string, Grant>();
  for (const g of grants) {
    const key = `${g.unitId ?? '*'}|${g.assetTypeId ?? '*'}`;
    const cur = best.get(key);
    if (!cur || rank[g.level] > rank[cur.level]) best.set(key, g);
  }
  return [...best.values()];
}

/**
 * Units someone may raise a request for: every unit they belong to or manage,
 * plus all of its ancestors (a team member can ask on behalf of the team, the
 * division, or the whole company).
 */
export function requestableUnitIds(principal: Pick<Principal, 'units' | 'isAdmin'>, unitPathOf: (unitId: string) => readonly string[] | undefined): Set<string> | 'all' {
  if (principal.isAdmin) return 'all';
  const out = new Set<string>();
  for (const u of principal.units) for (const id of unitPathOf(u.unitId) ?? [u.unitId]) out.add(id);
  return out;
}
