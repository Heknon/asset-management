import { z } from 'zod';

/**
 * Access is a set of permissions, usually chosen as a role:
 *
 *   Viewer       see items, their dates and documents
 *   Commenter    + write in conversations
 *   Contributor  + add documents and new items
 *   Editor       + change items, handle renewals and dates, export
 *   Admin        + secrets, delete, and manage access, catalogs and templates
 *   Custom       any combination (seeing is always included)
 *
 * Access is given to a person, an organization unit (everyone in it and in
 * the units beneath it) or a directory group (LDAP / ADFS), on:
 *   - an organization unit, including everything beneath it (optionally only one asset type)
 *   - the whole organization
 *   - a catalog (a named collection a unit shares)
 *
 * It adds up: someone's access to an item is the union of every grant that
 * reaches them. On top of explicit grants, unit members get the unit's default
 * member role, unit managers are Admins of their unit, and the owner of an
 * item can always see it, discuss it and add its documents.
 */

export const permissionKeys = ['view', 'comment', 'attach', 'create', 'edit', 'renew', 'export', 'restricted', 'delete', 'manage'] as const;
export type Permission = (typeof permissionKeys)[number];

export const permissionGroups = ['See', 'Contribute', 'Change', 'Control'] as const;

export const permissionMeta: Record<Permission, { label: string; description: string; group: (typeof permissionGroups)[number] }> = {
  view: { label: 'See items', description: 'Items, their fields, dates, documents and conversation', group: 'See' },
  export: { label: 'Export', description: 'Download tables as CSV', group: 'See' },
  restricted: { label: 'See secrets', description: 'Restricted fields such as license keys and PINs', group: 'See' },
  comment: { label: 'Comment', description: 'Write in conversations', group: 'Contribute' },
  attach: { label: 'Add documents', description: 'Upload contracts, invoices, quotes', group: 'Contribute' },
  create: { label: 'Add items', description: 'Create new items', group: 'Contribute' },
  edit: { label: 'Edit items', description: 'Change fields, status, owner, team and catalog', group: 'Change' },
  renew: { label: 'Handle renewals', description: 'Renew, snooze and dismiss dates, ask owners, and handle requests', group: 'Change' },
  delete: { label: 'Delete', description: 'Delete items, and anyone’s documents or messages', group: 'Control' },
  manage: { label: 'Manage access', description: 'Share, give access, create catalogs and team templates', group: 'Control' },
};

export const roleKeys = ['viewer', 'commenter', 'contributor', 'editor', 'admin'] as const;
export type RoleKey = (typeof roleKeys)[number];

export const roles: Record<RoleKey, { label: string; description: string; permissions: readonly Permission[] }> = {
  viewer: { label: 'Viewer', description: 'Can see everything, change nothing', permissions: ['view'] },
  commenter: { label: 'Commenter', description: 'Can see and join conversations', permissions: ['view', 'comment'] },
  contributor: { label: 'Contributor', description: 'Can add items and documents, not change others’', permissions: ['view', 'comment', 'attach', 'create'] },
  editor: { label: 'Editor', description: 'Can change items and handle renewals', permissions: ['view', 'comment', 'attach', 'create', 'edit', 'renew', 'export'] },
  admin: { label: 'Admin', description: 'Full control, including secrets and access', permissions: permissionKeys },
};

/** What owning an item gives, whatever your role: see it, discuss it, add its documents. */
export const ownerPermissions: readonly Permission[] = ['view', 'comment', 'attach'];

/** Canonical order, no duplicates, and seeing is always included. */
export function normalizePermissions(perms: Iterable<string>): Permission[] {
  const set = new Set(perms);
  if (set.size) set.add('view');
  return permissionKeys.filter((p) => set.has(p));
}

export function roleOf(perms: readonly Permission[]): RoleKey | 'custom' {
  const key = normalizePermissions(perms).join(',');
  return roleKeys.find((r) => roles[r].permissions.join(',') === key) ?? 'custom';
}

export const permissionsSchema = z.array(z.enum(permissionKeys)).min(1).max(permissionKeys.length).transform(normalizePermissions);

/** "Viewer" or a custom list; resolved to permissions. */
export const accessSchema = z
  .object({ role: z.enum([...roleKeys, 'custom']), permissions: z.array(z.enum(permissionKeys)).optional() })
  .transform((a, ctx) => {
    if (a.role !== 'custom') return [...roles[a.role].permissions];
    const perms = normalizePermissions(a.permissions ?? []);
    if (!perms.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose at least one permission' });
    return perms;
  });

/** Compact form for tokens. */
export const toMask = (perms: readonly Permission[]) => perms.reduce((m, p) => m | (1 << permissionKeys.indexOf(p)), 0);
export const fromMask = (mask: number): Permission[] => permissionKeys.filter((_, i) => mask & (1 << i));

/** Old three-level grants (and old tokens) map onto roles. */
export function permissionsOfLevel(level: string): Permission[] {
  if (level === 'manage') return [...roles.admin.permissions];
  if (level === 'edit') return [...roles.editor.permissions];
  if (level === 'view') return [...roles.viewer.permissions];
  return [];
}

export const grantSchema = z.object({
  unitId: z.string().uuid().nullable(),
  assetTypeId: z.string().uuid().nullable(),
  permissions: permissionsSchema,
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
  /** What catalog shares give the caller on this item, if any. */
  shared?: readonly Permission[];
}

export function effectivePermissions(principal: Pick<Principal, 'isAdmin' | 'grants'>, scope: AccessScope): Set<Permission> {
  if (principal.isAdmin) return new Set(permissionKeys);
  const out = new Set<Permission>(scope.shared ?? []);
  for (const g of principal.grants) {
    const unit = g.unitId === null || scope.unitPath.includes(g.unitId);
    const type = g.assetTypeId === null || g.assetTypeId === scope.assetTypeId;
    if (unit && type) g.permissions.forEach((p) => out.add(p));
  }
  return out;
}

export function can(principal: Pick<Principal, 'isAdmin' | 'grants'>, permission: Permission, scope: AccessScope): boolean {
  return effectivePermissions(principal, scope).has(permission);
}

/** For API responses: the caller's permissions, in canonical order. */
export const permissionList = (set: ReadonlySet<Permission>): Permission[] => permissionKeys.filter((p) => set.has(p));

/** A (unit subtree × asset type) pair where `null` means "any". */
export type Scope = Pick<Grant, 'unitId' | 'assetTypeId'>;

/**
 * Grants that include `permission`, as scopes a repository can turn into a
 * WHERE clause. A single `{null, null}` entry means unrestricted.
 */
export function scopesFor(principal: Pick<Principal, 'isAdmin' | 'grants'>, permission: Permission): Scope[] {
  if (principal.isAdmin) return [{ unitId: null, assetTypeId: null }];
  const scopes = principal.grants.filter((g) => g.permissions.includes(permission)).map(({ unitId, assetTypeId }) => ({ unitId, assetTypeId }));
  return scopes.some((s) => s.unitId === null && s.assetTypeId === null) ? [{ unitId: null, assetTypeId: null }] : scopes;
}

/** Combines grants from every source: per (unit, type), the union of permissions. */
export function consolidateGrants(grants: readonly Grant[]): Grant[] {
  const best = new Map<string, Grant>();
  for (const g of grants) {
    const key = `${g.unitId ?? '*'}|${g.assetTypeId ?? '*'}`;
    const cur = best.get(key);
    best.set(key, { unitId: g.unitId, assetTypeId: g.assetTypeId, permissions: normalizePermissions([...(cur?.permissions ?? []), ...g.permissions]) });
  }
  return [...best.values()];
}

/**
 * Access to a unit as a whole (its catalogs, team templates, access settings):
 * grants limited to one asset type only let you see it.
 */
export function unitPermissions(principal: Pick<Principal, 'isAdmin' | 'grants'>, unitPath: readonly string[]): Set<Permission> {
  if (principal.isAdmin) return new Set(permissionKeys);
  const out = new Set<Permission>();
  for (const g of principal.grants) {
    if (g.unitId !== null && !unitPath.includes(g.unitId)) continue;
    if (g.assetTypeId === null) g.permissions.forEach((p) => out.add(p));
    else out.add('view');
  }
  return out;
}

/** Org-tree scopes for unit-level things (catalogs): asset-type limits dropped. */
export function unitScopesFor(principal: Pick<Principal, 'isAdmin' | 'grants'>, permission: Permission): Scope[] {
  if (principal.isAdmin) return [{ unitId: null, assetTypeId: null }];
  const scopes = principal.grants.filter((g) => g.permissions.includes(permission) || (permission === 'view' && g.assetTypeId !== null));
  if (scopes.some((s) => s.unitId === null)) return [{ unitId: null, assetTypeId: null }];
  return [...new Set(scopes.map((s) => s.unitId!))].map((unitId) => ({ unitId, assetTypeId: null }));
}

/**
 * Templates (asset types) belong to the whole organization: admins, and people
 * who manage it (e.g. Procurement as Admin of the company) create and change them.
 */
export function canManageTemplates(principal: Pick<Principal, 'isAdmin' | 'grants'>, rootUnitIds: readonly string[]): boolean {
  return principal.isAdmin || principal.grants.some((g) => g.assetTypeId === null && g.permissions.includes('manage') && (g.unitId === null || rootUnitIds.includes(g.unitId)));
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

// ─── Who access is given to ────────────────────────────────────────────────

export const subjectKinds = ['user', 'unit', 'group'] as const;
export type SubjectKind = (typeof subjectKinds)[number];

/** How a subject is stored and matched: "user:<id>", "unit:<id>" (and every unit beneath), "group:<id>". */
export const subjectKey = (kind: SubjectKind, id: string) => `${kind}:${id}`;

export function parseSubjectKey(key: string): { kind: SubjectKind; id: string } {
  const i = key.indexOf(':');
  return { kind: key.slice(0, i) as SubjectKind, id: key.slice(i + 1) };
}

/**
 * The subject keys that reach someone: themselves, their directory groups,
 * every unit they belong to or manage, and every ancestor of those units (a
 * share with a division reaches all of its teams).
 */
export function subjectKeysOf(
  principal: Pick<Principal, 'userId' | 'units'>,
  unitPathOf: (unitId: string) => readonly string[] | undefined,
  groupIds: readonly string[] = [],
): string[] {
  const keys = new Set([subjectKey('user', principal.userId), ...groupIds.map((g) => subjectKey('group', g))]);
  for (const u of principal.units) for (const id of unitPathOf(u.unitId) ?? [u.unitId]) keys.add(subjectKey('unit', id));
  return [...keys];
}

/**
 * Resolves a caller's subject keys once per request (principals are per
 * request). Each service passes its own projections of units and groups.
 */
export class SubjectKeyResolver {
  private readonly memo = new WeakMap<object, Promise<string[]>>();

  constructor(
    private readonly unitPaths: (ids: string[]) => Promise<ReadonlyMap<string, readonly string[]>>,
    private readonly groupsOf: (userId: string) => Promise<readonly string[]>,
  ) {}

  of(p: Pick<Principal, 'userId' | 'units'>): Promise<string[]> {
    let keys = this.memo.get(p);
    if (!keys) {
      keys = Promise.all([this.unitPaths(p.units.map((u) => u.unitId)), this.groupsOf(p.userId)]).then(([paths, groups]) => subjectKeysOf(p, (id) => paths.get(id), groups));
      this.memo.set(p, keys);
    }
    return keys;
  }
}

/** Everything a repository needs to filter the rows a caller may see or act on. */
export interface Visibility {
  scopes: Scope[];
  /** Subject keys matched against catalog shares (empty: org tree only). */
  shareKeys: string[];
  permission: Permission;
  /** Items this person owns are included when owning gives the permission. */
  ownerId: string | null;
}

export function visibilityFor(principal: Pick<Principal, 'isAdmin' | 'grants'> & { userId?: string }, permission: Permission, shareKeys: readonly string[]): Visibility {
  return {
    scopes: scopesFor(principal, permission),
    shareKeys: principal.isAdmin ? [] : [...shareKeys],
    permission,
    ownerId: !principal.isAdmin && principal.userId && ownerPermissions.includes(permission) ? principal.userId : null,
  };
}

/** Union of the permissions of the shares that reach someone. */
export const unionPermissions = (lists: ReadonlyArray<readonly string[]>): Permission[] => normalizePermissions(lists.flat());
