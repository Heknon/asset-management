import {
  maxLevel,
  ShareKeyResolver,
  unitLevel,
  visibilityFor,
  type AccessLevel,
  type AccessScope,
  type Principal,
  type Visibility,
} from '@am/core';
import { scopeOf, type AssetState } from '../domain/asset.js';
import type { CatalogState } from '../domain/catalog.js';
import type { RegistryStore } from './ports.js';

/**
 * One place that answers "what can this caller reach?": org-tree grants from
 * the token, plus catalogs shared with them, their units or any ancestor unit.
 */
export class AccessResolver {
  private readonly keys: ShareKeyResolver;

  constructor(private readonly store: RegistryStore) {
    this.keys = new ShareKeyResolver((ids) => store.unitPaths(ids));
  }

  shareKeys(p: Principal): Promise<string[]> {
    return this.keys.of(p);
  }

  async visibility(p: Principal, required: AccessLevel): Promise<Visibility> {
    return visibilityFor(p, required, p.isAdmin ? [] : await this.shareKeys(p));
  }

  /** An asset's scope including what its catalog's shares give this caller. */
  async assetScope(p: Principal, asset: Pick<AssetState, 'unitPath' | 'assetTypeId' | 'catalogId'>, store: RegistryStore = this.store): Promise<AccessScope> {
    if (p.isAdmin || !asset.catalogId) return scopeOf(asset);
    return scopeOf(asset, await store.catalogShareLevel(asset.catalogId, await this.shareKeys(p)));
  }

  /** Share levels for the catalogs of many assets (listings). */
  async sharedLevels(p: Principal, catalogIds: Array<string | null>): Promise<Map<string, AccessLevel>> {
    const out = new Map<string, AccessLevel>();
    if (p.isAdmin) return out;
    const keys = await this.shareKeys(p);
    for (const id of new Set(catalogIds)) if (id) out.set(id, await this.store.catalogShareLevel(id, keys));
    return out;
  }

  /** Org-tree level on the catalog's unit, or what its shares give (view/edit). */
  async catalogLevel(p: Principal, catalog: Pick<CatalogState, 'unitPath' | 'shares'>): Promise<{ level: AccessLevel; viaShare: boolean }> {
    const tree = unitLevel(p, catalog.unitPath);
    if (p.isAdmin) return { level: tree, viaShare: false };
    const keys = new Set(await this.shareKeys(p));
    let shared: AccessLevel = 'none';
    for (const s of catalog.shares) if (keys.has(s.subjectKey)) shared = maxLevel(shared, s.level);
    return { level: maxLevel(tree, shared), viaShare: tree === 'none' && shared !== 'none' };
  }
}
