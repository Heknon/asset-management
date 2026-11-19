import {
  AppError,
  atLeast,
  shareSubjectKey,
  unitScopesFor,
  type Catalog,
  type CatalogInput,
  type CatalogQuery,
  type CatalogShareInput,
  type Principal,
} from '@am/core';
import { assetChangedEvent } from '../domain/asset.js';
import { catalogChangedEvent, parseSubjectKey, type CatalogState } from '../domain/catalog.js';
import type { AccessResolver } from './access.js';
import type { RegistryStore } from './ports.js';

/**
 * Catalogs: named collections of a unit's assets that the unit can share with
 * other units, divisions or people. Managers of the owning unit (or anyone
 * with manage above it) create, rename, share and delete them.
 */
export class CatalogService {
  constructor(
    private readonly store: RegistryStore,
    private readonly access: AccessResolver,
  ) {}

  async list(p: Principal, q: CatalogQuery): Promise<Catalog[]> {
    const rows = await this.store.listCatalogs({
      unitScopes: unitScopesFor(p, 'view'),
      shareKeys: p.isAdmin ? [] : await this.access.shareKeys(p),
      unitId: q.unitId,
      only: q.scope === 'all' ? undefined : q.scope,
    });
    return Promise.all(rows.map((c) => this.present(p, c)));
  }

  async get(p: Principal, id: string): Promise<Catalog> {
    const catalog = await this.store.getCatalog(id);
    if (!catalog || (await this.access.catalogLevel(p, catalog)).level === 'none') throw AppError.notFound('Catalog');
    return this.present(p, catalog);
  }

  async create(p: Principal, input: CatalogInput): Promise<Catalog> {
    const unit = await this.store.getUnit(input.unitId);
    if (!unit || unit.archived) throw AppError.validation('Unknown or archived unit');
    if (!atLeast((await this.access.catalogLevel(p, { unitPath: unit.path, shares: [] })).level, 'manage')) {
      throw AppError.forbidden(`Only people who manage ${unit.name} can create its catalogs`);
    }
    const catalog = await this.store.transaction(async (tx) => {
      const created = await tx.insertCatalog(input, { id: p.userId, name: p.displayName });
      await tx.publish('catalog.changed', catalogChangedEvent(created));
      return created;
    });
    return this.present(p, catalog);
  }

  async update(p: Principal, id: string, input: Omit<CatalogInput, 'unitId'>): Promise<Catalog> {
    return this.store.transaction(async (tx) => {
      await this.managed(tx, p, id);
      const saved = await tx.updateCatalog(id, input);
      await tx.publish('catalog.changed', catalogChangedEvent(saved));
      return this.present(p, saved);
    });
  }

  /** Deleting a catalog never deletes assets: they stay with their unit, unshared. */
  async remove(p: Principal, id: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      const catalog = await this.managed(tx, p, id);
      const kinds = new Map((await tx.listDateKinds()).map((k) => [k.id, k]));
      for (const asset of await tx.unfileAssets(id, p.userId)) {
        const type = (await tx.getType(asset.assetTypeId))!;
        await tx.addActivity({ assetId: asset.id, actorId: p.userId, actorName: p.displayName, action: 'updated', changes: { catalogId: { from: id, to: null } } });
        await tx.publish('asset.changed', assetChangedEvent(asset, type, kinds));
      }
      await tx.deleteCatalog(id);
      await tx.publish('catalog.changed', catalogChangedEvent({ ...catalog, version: catalog.version + 1 }, true));
    });
  }

  async share(p: Principal, id: string, input: CatalogShareInput): Promise<Catalog> {
    return this.store.transaction(async (tx) => {
      const catalog = await this.managed(tx, p, id);
      if (input.subjectKind === 'user') {
        if (!(await tx.activeUserIds([input.subjectId])).has(input.subjectId)) throw AppError.validation('Unknown or inactive person');
      } else {
        if (!(await tx.unitsExist([input.subjectId])).has(input.subjectId)) throw AppError.validation('Unknown or archived unit');
        if (catalog.unitPath.includes(input.subjectId)) throw AppError.validation('That unit already contains this catalog; its access comes from the organization tree');
      }
      await tx.putShare(id, shareSubjectKey(input.subjectKind, input.subjectId), input.level, p.displayName);
      const saved = await tx.touchCatalog(id);
      await tx.publish('catalog.changed', catalogChangedEvent(saved));
      return this.present(p, saved);
    });
  }

  async unshare(p: Principal, id: string, subject: Pick<CatalogShareInput, 'subjectKind' | 'subjectId'>): Promise<Catalog> {
    return this.store.transaction(async (tx) => {
      await this.managed(tx, p, id);
      if (!(await tx.removeShare(id, shareSubjectKey(subject.subjectKind, subject.subjectId)))) throw AppError.notFound('Share');
      const saved = await tx.touchCatalog(id);
      await tx.publish('catalog.changed', catalogChangedEvent(saved));
      return this.present(p, saved);
    });
  }

  private async managed(tx: RegistryStore, p: Principal, id: string): Promise<CatalogState> {
    const catalog = await tx.getCatalog(id, { forUpdate: true });
    const level = catalog ? (await this.access.catalogLevel(p, catalog)).level : 'none';
    if (!catalog || level === 'none') throw AppError.notFound('Catalog');
    if (!atLeast(level, 'manage')) throw AppError.forbidden('Only the managers of the owning unit can change this catalog or who it is shared with');
    return catalog;
  }

  private async present(p: Principal, c: CatalogState): Promise<Catalog> {
    const { level, viaShare } = await this.access.catalogLevel(p, c);
    return {
      id: c.id,
      unitId: c.unitId,
      name: c.name,
      description: c.description,
      icon: c.icon,
      color: c.color,
      assetCount: c.assetCount,
      access: level,
      sharedWithMe: viaShare,
      shares: c.shares.map((s) => ({ ...parseSubjectKey(s.subjectKey), level: s.level, createdByName: s.createdByName, createdAt: s.createdAt.toISOString() })),
      createdByName: c.createdByName,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }
}
