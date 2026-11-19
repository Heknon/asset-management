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
 *
 * On top of the tree, a unit can share a *catalog* (a named collection of its
 * assets) with other units or people, at view or edit. Shares only ever add
 * access, never manage: restricted fields and deletion stay with the owners.
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
  /** Access the caller gets through a catalog share, if any (capped at edit). */
  shared?: AccessLevel;
}

export function atLeast(level: AccessLevel, required: AccessLevel): boolean {
  return rank[level] >= rank[required];
}

export function maxLevel(a: AccessLevel, b: AccessLevel): AccessLevel {
  return rank[a] >= rank[b] ? a : b;
}

export function effectiveLevel(principal: Pick<Principal, 'isAdmin' | 'grants'>, scope: AccessScope): AccessLevel {
  if (principal.isAdmin) return 'manage';
  let level: AccessLevel = scope.shared === 'view' ? 'view' : scope.shared === 'edit' || scope.shared === 'manage' ? 'edit' : 'none';
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

// ─── Catalog shares ────────────────────────────────────────────────────────

export type ShareSubjectKind = 'unit' | 'user';
export type ShareLevel = 'view' | 'edit';

/** How a share is stored and matched: "unit:<id>" (that unit and everything beneath it) or "user:<id>". */
export const shareSubjectKey = (kind: ShareSubjectKind, id: string) => `${kind}:${id}`;

/**
 * The share keys that reach the caller: themselves, every unit they belong to
 * or manage, and every ancestor of those units (a share with a division
 * reaches all of its teams).
 */
export function shareKeysOf(principal: Pick<Principal, 'userId' | 'units'>, unitPathOf: (unitId: string) => readonly string[] | undefined): string[] {
  const keys = new Set([shareSubjectKey('user', principal.userId)]);
  for (const u of principal.units) for (const id of unitPathOf(u.unitId) ?? [u.unitId]) keys.add(shareSubjectKey('unit', id));
  return [...keys];
}

/**
 * Resolves a caller's share keys once per request (principals are per
 * request). Each service passes its own unit-path lookup.
 */
export class ShareKeyResolver {
  private readonly memo = new WeakMap<object, Promise<string[]>>();

  constructor(private readonly unitPaths: (ids: string[]) => Promise<ReadonlyMap<string, readonly string[]>>) {}

  of(p: Pick<Principal, 'userId' | 'units'>): Promise<string[]> {
    let keys = this.memo.get(p);
    if (!keys) {
      keys = this.unitPaths(p.units.map((u) => u.unitId)).then((paths) => shareKeysOf(p, (id) => paths.get(id)));
      this.memo.set(p, keys);
    }
    return keys;
  }
}

/** Share levels that satisfy `required` (shares never satisfy manage). */
export function shareLevelsFor(required: AccessLevel): ShareLevel[] {
  if (required === 'view' || required === 'none') return ['view', 'edit'];
  return required === 'edit' ? ['edit'] : [];
}

/** Everything a repository needs to filter the rows a caller may see (or change) at a level. */
export interface Visibility {
  scopes: Scope[];
  shareKeys: string[];
  shareLevels: ShareLevel[];
}

export function visibilityFor(principal: Pick<Principal, 'isAdmin' | 'grants'>, required: AccessLevel, shareKeys: readonly string[]): Visibility {
  return { scopes: scopesFor(principal, required), shareKeys: [...shareKeys], shareLevels: principal.isAdmin ? [] : shareLevelsFor(required) };
}

/** The best level among the shares that reach someone. */
export function bestShareLevel(levels: readonly string[]): AccessLevel {
  return levels.includes('edit') ? 'edit' : levels.includes('view') ? 'view' : 'none';
}

/**
 * Access to a unit as a whole (catalogs, which hold several asset types): a
 * grant limited to one asset type gives at most view.
 */
export function unitLevel(principal: Pick<Principal, 'isAdmin' | 'grants'>, unitPath: readonly string[]): AccessLevel {
  if (principal.isAdmin) return 'manage';
  let level: AccessLevel = 'none';
  for (const g of principal.grants) {
    if (g.unitId !== null && !unitPath.includes(g.unitId)) continue;
    level = maxLevel(level, g.assetTypeId === null ? g.level : 'view');
  }
  return level;
}

/** Org-tree scopes for unit-level things (catalogs): asset-type limits dropped. */
export function unitScopesFor(principal: Pick<Principal, 'isAdmin' | 'grants'>, required: AccessLevel): Scope[] {
  const scopes = scopesFor(principal, required);
  if (scopes.some((s) => s.unitId === null)) return [{ unitId: null, assetTypeId: null }];
  return [...new Set(scopes.map((s) => s.unitId!))].map((unitId) => ({ unitId, assetTypeId: null }));
}
