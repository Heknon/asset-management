import {
  advanceRecurringDate,
  AppError,
  buildSearchText,
  effectivePermissions,
  firstOfCategory,
  mergeAttributes,
  ownerPermissions,
  permissionList,
  redactAttributes,
  type AccessCheck,
  type Asset,
  type AssetCreate,
  type AssetQuery,
  type AssetUpdate,
  type Page,
  type Permission,
  type Principal,
} from '@am/core';
import { authorize } from '@am/platform';
import { assertFitsVariant, assetChangedEvent, diff, resolveStatus, scopeOf, validatedOverrides, validatedValues, type AssetDraft, type AssetState } from '../domain/asset.js';
import { assertFitsCatalog } from '../domain/catalog.js';
import { requestNumber } from '../domain/request.js';
import type { AccessResolver } from './access.js';
import type { RegistryStore } from './ports.js';
import { itemSchema, referenceOf, type ItemSchema } from './schema.js';
import { completeRenewals, requestChangedEvent, workflowFor } from './workflows.js';

export class AssetService {
  constructor(
    private readonly store: RegistryStore,
    private readonly resolver: AccessResolver,
  ) {}

  /** Assets the caller can see (or, for exports, export). */
  async list(principal: Principal, query: AssetQuery, permission: Permission = 'view'): Promise<Page<Asset>> {
    const visibility = await this.resolver.visibility(principal, permission);
    const type = query.assetTypeId ? await this.store.getType(query.assetTypeId) : null;
    // Filters on a variant's own fields need the variant's schema.
    const filterSchema = type && query.variantId ? ((await itemSchema(this.store, type.id, query.variantId))?.schema ?? type) : type;
    const { items, total } = await this.store.queryAssets(query, visibility, filterSchema);
    const [schemas, shared] = await Promise.all([this.schemas(items), this.resolver.sharedPermissions(principal, items.map((a) => a.catalogId))]);
    return {
      items: items.map((a) => ({
        ...this.present(principal, a, schemas.get(schemaKey(a))!, [...(a.ownerId === principal.userId ? ownerPermissions : []), ...(a.catalogId ? (shared.get(a.catalogId) ?? []) : [])]),
        ...(a.snippet && { snippet: a.snippet }),
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async get(principal: Principal, id: string): Promise<Asset> {
    const asset = await this.store.getAsset(id);
    if (!asset) throw AppError.notFound('Asset');
    const scope = await this.resolver.assetScope(principal, asset);
    authorize(principal, 'view', scope);
    return this.present(principal, asset, await this.schemaOf(this.store, asset), scope.shared);
  }

  /** For other application services (conversations): the asset and the caller's permissions, or not found / forbidden. */
  async reach(principal: Principal, id: string, required: Permission): Promise<{ asset: AssetState; permissions: Set<Permission> }> {
    const asset = await this.store.getAsset(id);
    if (!asset) throw AppError.notFound('Asset');
    return { asset, permissions: authorize(principal, required, await this.resolver.assetScope(principal, asset)) };
  }

  /** Used by other services (files) to authorise access to an asset on behalf of a user. */
  async access(principal: Principal, id: string): Promise<AccessCheck> {
    const asset = await this.store.getAsset(id);
    if (!asset) throw AppError.notFound('Asset');
    const perms = effectivePermissions(principal, await this.resolver.assetScope(principal, asset));
    if (!perms.has('view')) throw AppError.notFound('Asset');
    return { assetId: asset.id, assetTypeId: asset.assetTypeId, unitId: asset.unitId, catalogId: asset.catalogId, permissions: permissionList(perms) };
  }

  async create(principal: Principal, input: AssetCreate, store: RegistryStore = this.store): Promise<Asset> {
    const type = await store.getType(input.assetTypeId);
    if (!type) throw AppError.validation('Unknown asset type');
    if (type.archived) throw AppError.validation(`"${type.name}" is archived; new assets cannot be created`);
    const unitPath = await this.unitPath(input.unitId, store);
    const sch = await this.resolveVariant(store, type.id, input.variantId, unitPath);
    // Someone a catalog is shared with (with "Add items") may add to it, inside its unit.
    const scope = await this.resolver.assetScope(principal, { unitPath, assetTypeId: type.id, catalogId: input.catalogId }, store);
    const perms = authorize(principal, 'create', scope);
    await this.assertCatalog(store, principal, input.catalogId, unitPath);
    await this.assertPeople(sch, input.ownerId, input.attributes, store);
    const { merged, blocked } = mergeAttributes(sch.schema.fields, {}, input.attributes, perms.has('restricted'));
    if (blocked.length) throw AppError.forbidden(`Setting ${blocked.join(', ')} needs the “See secrets” permission`);

    const draft: AssetDraft = {
      assetTypeId: type.id,
      typeVersion: type.version,
      name: input.name.trim(),
      status: resolveStatus(type, input.status),
      ownerId: input.ownerId ?? principal.userId,
      unitId: input.unitId,
      catalogId: input.catalogId,
      variantId: sch.variant?.id ?? null,
      values: validatedValues(sch.schema, merged),
      reminderOverrides: validatedOverrides(sch.schema, input.reminderOverrides),
    };
    const run = async (tx: RegistryStore) => {
      const created = await tx.insertAsset(draft, principal.userId, '');
      await tx.setSearchText(created.id, await this.searchText(tx, sch, draft, created.refNo));
      const changes = diff(sch.schema, null, draft);
      if (input.requestId) changes.request = { from: null, to: await this.fulfil(tx, principal, input.requestId, created.id) };
      await tx.addActivity({ assetId: created.id, actorId: principal.userId, actorName: principal.displayName, action: 'created', changes });
      await tx.publish('asset.changed', assetChangedEvent(created, sch.schema, await this.kinds(tx)));
      return created;
    };
    // Inside an import the caller already holds a transaction.
    const asset = store === this.store ? await this.store.transaction(run) : await run(store);
    return this.present(principal, asset, sch, scope.shared);
  }

  /** Closes the request this new asset was bought for. Only its handlers may do this. */
  private async fulfil(tx: RegistryStore, principal: Principal, requestId: string, assetId: string): Promise<string> {
    const request = await tx.getRequest(requestId, { forUpdate: true });
    if (!request) throw AppError.validation('Unknown request');
    if (!effectivePermissions(principal, { unitPath: request.unitPath, assetTypeId: request.assetTypeId ?? '' }).has('renew')) {
      throw AppError.forbidden('You cannot fulfil this request');
    }
    if (request.statusCategory === 'done' || request.statusCategory === 'closed') throw AppError.conflict('The request is already closed');
    const wf = await workflowFor(tx, request.assetTypeId);
    const done = firstOfCategory(wf, 'done')!;
    await tx.setRequestStatus(request.id, done, assetId);
    await tx.addRequestEvent({ requestId: request.id, actorId: principal.userId, actorName: principal.displayName, kind: 'fulfilled', body: null, fromStatus: request.status, toStatus: done.key });
    await tx.publish('request.changed', requestChangedEvent({ ...request, status: done.key, statusCategory: 'done' }, wf, { id: principal.userId, name: principal.displayName }, 'fulfilled', request.status, null));
    return requestNumber(request.seq);
  }

  async update(principal: Principal, id: string, patch: AssetUpdate, store: RegistryStore = this.store): Promise<Asset> {
    const run = async (tx: RegistryStore) => {
      const current = await tx.getAsset(id, { forUpdate: true });
      if (!current) throw AppError.notFound('Asset');
      const perms = authorize(principal, 'edit', await this.resolver.assetScope(principal, current, tx));
      const type = (await tx.getType(current.assetTypeId))!;

      // Moving an asset to another unit needs "Add items" on the destination too.
      let unitPath = current.unitPath;
      if (patch.unitId && patch.unitId !== current.unitId) {
        unitPath = await this.unitPath(patch.unitId, tx);
        authorize(principal, 'create', { unitPath, assetTypeId: type.id });
      }
      // Filing into (or out of) a catalog changes who can see the asset: edit on both catalogs.
      const catalogId = patch.catalogId !== undefined ? patch.catalogId : current.catalogId;
      if (catalogId !== current.catalogId) {
        await this.assertCatalog(tx, principal, current.catalogId, null);
        await this.assertCatalog(tx, principal, catalogId, unitPath);
      } else if (catalogId && unitPath !== current.unitPath) {
        assertFitsCatalog((await tx.getCatalog(catalogId))!, unitPath);
      }
      const sch = await this.resolveVariant(tx, type.id, patch.variantId !== undefined ? patch.variantId : current.variantId, unitPath, current.variantId);
      await this.assertPeople(sch, patch.ownerId ?? null, patch.attributes ?? {}, tx);

      const { merged, blocked } = mergeAttributes(sch.schema.fields, current.values, patch.attributes ?? {}, perms.has('restricted'));
      if (blocked.length) throw AppError.forbidden(`Changing ${blocked.join(', ')} needs the “See secrets” permission`);
      const draft: AssetDraft = {
        assetTypeId: type.id,
        typeVersion: type.version,
        name: patch.name?.trim() ?? current.name,
        status: patch.status !== undefined ? resolveStatus(type, patch.status) : current.status,
        ownerId: patch.ownerId !== undefined ? patch.ownerId : current.ownerId,
        unitId: patch.unitId ?? current.unitId,
        catalogId,
        variantId: sch.variant?.id ?? null,
        values: validatedValues(sch.schema, merged),
        reminderOverrides: patch.reminderOverrides ? validatedOverrides(sch.schema, patch.reminderOverrides) : current.reminderOverrides,
      };
      const changes = diff(sch.schema, current, draft);
      if (!Object.keys(changes).length) return this.present(principal, current, sch, (await this.resolver.assetScope(principal, current, tx)).shared);
      const saved = await tx.saveAsset(id, draft, principal.userId, await this.searchText(tx, sch, draft, current.refNo));
      await tx.addActivity({ assetId: id, actorId: principal.userId, actorName: principal.displayName, action: 'updated', changes });
      await tx.publish('asset.changed', assetChangedEvent(saved, sch.schema, await this.kinds(tx)));
      return this.present(principal, saved, sch, (await this.resolver.assetScope(principal, saved, tx)).shared);
    };
    return store === this.store ? this.store.transaction(run) : run(store);
  }

  /** "Renewed" / "Paid": rolls a recurring date forward by its interval, and finishes its open renewal requests. */
  async advance(principal: Principal, id: string, fieldKey: string, opts: { store?: RegistryStore; skipRequestId?: string } = {}): Promise<Asset> {
    const run = async (tx: RegistryStore) => {
      const current = await tx.getAsset(id, { forUpdate: true });
      if (!current) throw AppError.notFound('Asset');
      const scope = await this.resolver.assetScope(principal, current, tx);
      authorize(principal, 'renew', scope);
      const sch = await this.schemaOf(tx, current);
      const kinds = await this.kinds(tx);
      const { values, from, to } = advanceRecurringDate(sch.schema, current.values, fieldKey, kinds);
      const draft: AssetDraft = { ...current, typeVersion: sch.type.version, values };
      const saved = await tx.saveAsset(id, draft, principal.userId, await this.searchText(tx, sch, draft, current.refNo));
      await tx.addActivity({ assetId: id, actorId: principal.userId, actorName: principal.displayName, action: 'advanced', changes: diff(sch.schema, current, draft) });
      const affected = sch.schema.fields.filter((f) => f.kind === 'date' && current.values[f.key] !== values[f.key]).map((f) => f.key);
      await tx.publish('asset.changed', assetChangedEvent(saved, sch.schema, kinds, { fieldKey, from, to, by: principal.userId, affected }));
      await completeRenewals(tx, id, fieldKey, { id: principal.userId, name: principal.displayName }, opts.skipRequestId);
      return this.present(principal, saved, sch, scope.shared);
    };
    return opts.store ? run(opts.store) : this.store.transaction(run);
  }

  async remove(principal: Principal, id: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      const current = await tx.getAsset(id, { forUpdate: true });
      if (!current) throw AppError.notFound('Asset');
      authorize(principal, 'delete', await this.resolver.assetScope(principal, current, tx));
      await tx.deleteAsset(id);
      await tx.addActivity({ assetId: id, actorId: principal.userId, actorName: principal.displayName, action: 'deleted', changes: { name: { from: current.name, to: null } } });
      await tx.publish('asset.deleted', { assetId: id });
    });
  }

  async activity(principal: Principal, id: string) {
    await this.reach(principal, id, 'view');
    return this.store.listActivity(id, 200);
  }

  /**
   * Rebuilds search text when something it mentions changes elsewhere
   * (a unit or person renamed) or after upgrades. Search-only: no version bump.
   */
  async reindex(where: { unitIds?: string[]; userIds?: string[]; unindexed?: boolean }): Promise<number> {
    const ids = await this.store.assetIdsToReindex(where);
    for (const id of ids) {
      const asset = await this.store.getAsset(id);
      if (asset) await this.store.setSearchText(id, await this.searchText(this.store, await this.schemaOf(this.store, asset), asset, asset.refNo));
    }
    return ids.length;
  }

  /** The schema an existing item follows (template + its variant). */
  async schemaOf(store: RegistryStore, asset: Pick<AssetState, 'assetTypeId' | 'variantId'>): Promise<ItemSchema> {
    return (await itemSchema(store, asset.assetTypeId, asset.variantId))!;
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  /** A chosen variant must belong to the template and be available to the item's unit. */
  private async resolveVariant(store: RegistryStore, typeId: string, variantId: string | null | undefined, unitPath: string[], currentVariantId?: string | null): Promise<ItemSchema> {
    const sch = await itemSchema(store, typeId, variantId);
    if (!sch) throw AppError.validation('Unknown asset type');
    if (variantId && !sch.variant) throw AppError.validation('Unknown variant');
    if (sch.variant) {
      if (sch.variant.archived && sch.variant.id !== currentVariantId) throw AppError.validation(`“${sch.variant.name}” is archived`);
      assertFitsVariant(sch.variant, typeId, unitPath);
    }
    return sch;
  }

  private async schemas(items: AssetState[]): Promise<Map<string, ItemSchema>> {
    const out = new Map<string, ItemSchema>();
    for (const a of items) {
      const k = schemaKey(a);
      if (!out.has(k)) out.set(k, await this.schemaOf(this.store, a));
    }
    return out;
  }

  private async searchText(store: RegistryStore, sch: ItemSchema, draft: AssetDraft, refNo: number): Promise<string> {
    const { schema, type, variant } = sch;
    const refs = (kind: 'user' | 'assetRef') => schema.fields.filter((f) => f.kind === kind).flatMap((f) => [draft.values[f.key]].flat()).filter((v): v is string => typeof v === 'string');
    const unit = await store.getUnit(draft.unitId);
    // Search names, so an asset is found by its owner's username, email or other names too.
    const [people, assets, unitNames] = await Promise.all([store.userSearchNames([draft.ownerId, ...refs('user')].filter((v): v is string => !!v)), store.assetNames(refs('assetRef')), store.unitNames(unit?.path ?? [draft.unitId])]);
    return buildSearchText(schema, draft.name, draft.values, draft.ownerId ? people.get(draft.ownerId) : undefined, {
      typeName: type.name,
      variantName: variant?.name,
      reference: referenceOf(type, refNo),
      statusLabel: type.statuses.find((s) => s.value === draft.status)?.label ?? draft.status,
      // The whole path, so "marketing figma" finds Figma in any Marketing team.
      unitName: (unit?.path ?? []).map((id) => unitNames.get(id)).filter(Boolean).join(' › '),
      personName: (id) => people.get(id),
      assetName: (id) => assets.get(id),
    });
  }

  /**
   * Filing into a catalog shares the asset with the catalog's audience, so it
   * needs edit on the catalog; the asset must sit within the catalog's unit.
   */
  private async assertCatalog(store: RegistryStore, principal: Principal, catalogId: string | null, assetUnitPath: string[] | null) {
    if (!catalogId) return;
    const catalog = await store.getCatalog(catalogId);
    if (!catalog) throw AppError.validation('Unknown catalog');
    if (assetUnitPath) assertFitsCatalog(catalog, assetUnitPath);
    if (!(await this.resolver.catalogPermissions(principal, catalog)).permissions.has('edit')) throw AppError.forbidden(`Changing what is in “${catalog.name}” needs “Edit items” on it`);
  }

  private present(principal: Principal, asset: AssetState, sch: ItemSchema, shared?: readonly Permission[]): Asset {
    const perms = effectivePermissions(principal, scopeOf(asset, shared));
    return {
      id: asset.id,
      reference: referenceOf(sch.type, asset.refNo),
      assetTypeId: asset.assetTypeId,
      variantId: asset.variantId,
      typeVersion: asset.typeVersion,
      name: asset.name,
      status: asset.status,
      ownerId: asset.ownerId,
      unitId: asset.unitId,
      catalogId: asset.catalogId,
      attributes: redactAttributes(sch.schema.fields, asset.values, perms.has('restricted')),
      reminderOverrides: asset.reminderOverrides,
      permissions: permissionList(perms),
      createdAt: asset.createdAt.toISOString(),
      updatedAt: asset.updatedAt.toISOString(),
    };
  }

  private async kinds(store: RegistryStore = this.store) {
    return new Map((await store.listDateKinds()).map((k) => [k.id, k]));
  }

  /** The unit must exist and be active; returns its ancestor path for access checks. */
  private async unitPath(unitId: string, store = this.store): Promise<string[]> {
    const unit = await store.getUnit(unitId);
    if (!unit || unit.archived) throw AppError.validation('Unknown or archived team');
    return unit.path;
  }

  /** People referenced by an asset must exist (via the local projection). */
  private async assertPeople(sch: ItemSchema, ownerId: string | null, attributes: Record<string, unknown>, store = this.store) {
    const userKeys = sch.schema.fields.filter((f) => f.kind === 'user').map((f) => f.key);
    const ids = [ownerId, ...userKeys.map((k) => attributes[k])].filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (!ids.length) return;
    const known = await store.activeUserIds(ids);
    const unknown = ids.filter((i) => !known.has(i));
    if (unknown.length) throw AppError.validation('Unknown or inactive person selected', { users: unknown });
  }
}

const schemaKey = (a: Pick<AssetState, 'assetTypeId' | 'variantId'>) => `${a.assetTypeId}|${a.variantId ?? ''}`;
