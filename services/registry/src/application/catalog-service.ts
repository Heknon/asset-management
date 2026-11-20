import {
  AppError,
  permissionList,
  subjectKey,
  unitScopesFor,
  type Catalog,
  type CatalogInput,
  type CatalogQuery,
  type CatalogShareInput,
  type SubjectKind,
  type Principal,
} from '@am/core';
import { assetChangedEvent } from '../domain/asset.js';
import { catalogChangedEvent, type CatalogState } from '../domain/catalog.js';
import type { AccessResolver } from './access.js';
import type { RegistryStore } from './ports.js';
import { itemSchema } from './schema.js';

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
    return this.presentAll(p, rows);
  }

  async get(p: Principal, id: string): Promise<Catalog> {
    const catalog = await this.store.getCatalog(id);
    if (!catalog || !(await this.access.catalogPermissions(p, catalog)).permissions.has('view')) throw AppError.notFound('Catalog');
    return this.present(p, catalog);
  }

  async create(p: Principal, input: CatalogInput): Promise<Catalog> {
    const unit = await this.store.getUnit(input.unitId);
    if (!unit || unit.archived) throw AppError.validation('Unknown or archived unit');
    if (!(await this.access.catalogPermissions(p, { unitPath: unit.path, shares: [] })).permissions.has('manage')) {
      throw AppError.forbidden(`Creating catalogs for ${unit.name} needs “Manage access” on it`);
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
        const sch = (await itemSchema(tx, asset.assetTypeId, asset.variantId))!;
        await tx.addActivity({ assetId: asset.id, actorId: p.userId, actorName: p.displayName, action: 'updated', changes: { catalogId: { from: id, to: null } } });
        await tx.publish('asset.changed', assetChangedEvent(asset, sch.schema, kinds));
      }
      await tx.deleteCatalog(id);
      await tx.publish('catalog.changed', catalogChangedEvent({ ...catalog, version: catalog.version + 1 }, true));
    });
  }

  async share(p: Principal, id: string, input: CatalogShareInput): Promise<Catalog> {
    return this.store.transaction(async (tx) => {
      await this.managed(tx, p, id);
      const { kind, id: subjectId } = input.subject;
      if (kind === 'user' && !(await tx.activeUserIds([subjectId])).has(subjectId)) throw AppError.validation('Unknown or inactive person');
      if (kind === 'unit' && !(await tx.unitsExist([subjectId])).has(subjectId)) throw AppError.validation('Unknown or archived unit');
      // Groups are not checked: a group synced moments ago may not have reached this service yet,
      // and a share with a group nobody is in gives nobody access. Its name appears once it arrives.
      await tx.putShare(id, subjectKey(kind, subjectId), input.access, p.displayName);
      const saved = await tx.touchCatalog(id);
      await tx.publish('catalog.changed', catalogChangedEvent(saved));
      return this.present(p, saved);
    });
  }

  async unshare(p: Principal, id: string, subject: { kind: SubjectKind; id: string }): Promise<Catalog> {
    return this.store.transaction(async (tx) => {
      await this.managed(tx, p, id);
      if (!(await tx.removeShare(id, subjectKey(subject.kind, subject.id)))) throw AppError.notFound('Share');
      const saved = await tx.touchCatalog(id);
      await tx.publish('catalog.changed', catalogChangedEvent(saved));
      return this.present(p, saved);
    });
  }

  private async managed(tx: RegistryStore, p: Principal, id: string): Promise<CatalogState> {
    const catalog = await tx.getCatalog(id, { forUpdate: true });
    const perms = catalog ? (await this.access.catalogPermissions(p, catalog)).permissions : new Set();
    if (!catalog || !perms.has('view')) throw AppError.notFound('Catalog');
    if (!perms.has('manage')) throw AppError.forbidden('Changing this catalog or who it is shared with needs “Manage access” on it');
    return catalog;
  }

  private async present(p: Principal, c: CatalogState): Promise<Catalog> {
    return (await this.presentAll(p, [c]))[0]!;
  }

  private async presentAll(p: Principal, rows: CatalogState[]): Promise<Catalog[]> {
    const names = await this.store.describeSubjects([...new Set(rows.flatMap((c) => c.shares.map((s) => s.subjectKey)))]);
    return Promise.all(
      rows.map(async (c) => {
        const { permissions, viaShare } = await this.access.catalogPermissions(p, c);
        return {
          id: c.id,
          unitId: c.unitId,
          name: c.name,
          description: c.description,
          icon: c.icon,
          color: c.color,
          assetCount: c.assetCount,
          permissions: permissionList(permissions),
          sharedWithMe: viaShare,
          shares: c.shares.map((s) => ({ subject: names.get(s.subjectKey)!, permissions: s.permissions, createdByName: s.createdByName, createdAt: s.createdAt.toISOString() })),
          createdByName: c.createdByName,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        };
      }),
    );
  }
}
