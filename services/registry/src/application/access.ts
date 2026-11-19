import {
  effectivePermissions,
  ownerPermissions,
  SubjectKeyResolver,
  unionPermissions,
  unitPermissions,
  visibilityFor,
  type AccessScope,
  type Permission,
  type Principal,
  type Visibility,
} from '@am/core';
import { scopeOf, type AssetState } from '../domain/asset.js';
import type { CatalogState } from '../domain/catalog.js';
import type { RegistryStore } from './ports.js';

/**
 * One place that answers "what can this caller do?": org-tree grants from
 * the token, plus catalogs shared with them, their directory groups, their
 * units or any ancestor unit.
 */
export class AccessResolver {
  private readonly keys: SubjectKeyResolver;

  constructor(private readonly store: RegistryStore) {
    this.keys = new SubjectKeyResolver(
      (ids) => store.unitPaths(ids),
      (userId) => store.groupIdsOf(userId),
    );
  }

  shareKeys(p: Principal): Promise<string[]> {
    return this.keys.of(p);
  }

  async visibility(p: Principal, permission: Permission): Promise<Visibility> {
    return visibilityFor(p, permission, p.isAdmin ? [] : await this.shareKeys(p));
  }

  /** An asset's scope including what its catalog's shares give this caller. */
  async assetScope(p: Principal, asset: Pick<AssetState, 'unitPath' | 'assetTypeId' | 'catalogId'> & { ownerId?: string | null }, store: RegistryStore = this.store): Promise<AccessScope> {
    const owned = asset.ownerId && asset.ownerId === p.userId ? ownerPermissions : [];
    if (p.isAdmin || !asset.catalogId) return scopeOf(asset, owned);
    return scopeOf(asset, [...owned, ...(await store.catalogSharePermissions(asset.catalogId, await this.shareKeys(p)))]);
  }

  /** Share permissions for the catalogs of many assets (listings). */
  async sharedPermissions(p: Principal, catalogIds: Array<string | null>): Promise<Map<string, Permission[]>> {
    const out = new Map<string, Permission[]>();
    if (p.isAdmin) return out;
    const keys = await this.shareKeys(p);
    for (const id of new Set(catalogIds)) if (id) out.set(id, await this.store.catalogSharePermissions(id, keys));
    return out;
  }

  /** What the caller may do with a catalog: their role on its unit, plus what its shares give them. */
  async catalogPermissions(p: Principal, catalog: Pick<CatalogState, 'unitPath' | 'shares'>): Promise<{ permissions: Set<Permission>; viaShare: boolean }> {
    const tree = unitPermissions(p, catalog.unitPath);
    if (p.isAdmin) return { permissions: tree, viaShare: false };
    const keys = new Set(await this.shareKeys(p));
    const shared = unionPermissions(catalog.shares.filter((s) => keys.has(s.subjectKey)).map((s) => s.permissions));
    return { permissions: new Set([...tree, ...shared]), viaShare: !tree.has('view') && shared.length > 0 };
  }

  /** Permissions on one asset. */
  async on(p: Principal, asset: Pick<AssetState, 'unitPath' | 'assetTypeId' | 'catalogId' | 'ownerId'>): Promise<Set<Permission>> {
    return effectivePermissions(p, await this.assetScope(p, asset));
  }
}
