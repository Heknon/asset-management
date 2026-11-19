import {
  advanceRecurringDate,
  AppError,
  atLeast,
  buildSearchText,
  effectiveLevel,
  mergeAttributes,
  redactAttributes,
  scopesFor,
  type AccessCheck,
  type AccessLevel,
  type Asset,
  type AssetCreate,
  type AssetQuery,
  type AssetType,
  type AssetUpdate,
  type Page,
  type Principal,
} from '@am/core';
import { authorize } from '@am/platform';
import { assetChangedEvent, diff, resolveStatus, scopeOf, validatedOverrides, validatedValues, type AssetDraft, type AssetState } from '../domain/asset.js';
import { requestNumber } from '../domain/request.js';
import type { RegistryStore } from './ports.js';

export class AssetService {
  constructor(private readonly store: RegistryStore) {}

  async list(principal: Principal, query: AssetQuery): Promise<Page<Asset>> {
    const scopes = scopesFor(principal, 'view');
    const type = query.assetTypeId ? await this.store.getType(query.assetTypeId) : null;
    const { items, total } = scopes.length ? await this.store.queryAssets(query, scopes, type) : { items: [], total: 0 };
    const types = await this.typeMap(items.map((a) => a.assetTypeId));
    return { items: items.map((a) => ({ ...this.present(principal, a, types.get(a.assetTypeId)!), ...(a.snippet && { snippet: a.snippet }) })), total, limit: query.limit, offset: query.offset };
  }

  async get(principal: Principal, id: string): Promise<Asset> {
    const { asset, type } = await this.load(id);
    authorize(principal, 'view', scopeOf(asset));
    return this.present(principal, asset, type);
  }

  /** Used by other services (files) to authorise access to an asset on behalf of a user. */
  async access(principal: Principal, id: string): Promise<AccessCheck> {
    const asset = await this.store.getAsset(id);
    if (!asset) throw AppError.notFound('Asset');
    const level = effectiveLevel(principal, scopeOf(asset));
    if (level === 'none') throw AppError.notFound('Asset');
    return { assetId: asset.id, assetTypeId: asset.assetTypeId, unitId: asset.unitId, level };
  }

  async create(principal: Principal, input: AssetCreate): Promise<Asset> {
    const type = await this.activeType(input.assetTypeId);
    const unitPath = await this.unitPath(input.unitId);
    const level = authorize(principal, 'edit', { unitPath, assetTypeId: type.id });
    await this.assertPeople(type, input.ownerId, input.attributes);
    const { merged, blocked } = mergeAttributes(type.fields, {}, input.attributes, atLeast(level, 'manage'));
    if (blocked.length) throw AppError.forbidden(`Only managers can set: ${blocked.join(', ')}`);

    const draft: AssetDraft = {
      assetTypeId: type.id,
      typeVersion: type.version,
      name: input.name.trim(),
      status: resolveStatus(type, input.status),
      ownerId: input.ownerId ?? principal.userId,
      unitId: input.unitId,
      values: validatedValues(type, merged),
      reminderOverrides: validatedOverrides(type, input.reminderOverrides),
    };
    const asset = await this.store.transaction(async (tx) => {
      const created = await tx.insertAsset(draft, principal.userId, await this.searchText(tx, type, draft));
      const changes = diff(type, null, draft);
      if (input.requestId) changes.request = { from: null, to: await this.fulfil(tx, principal, input.requestId, created.id) };
      await tx.addActivity({ assetId: created.id, actorId: principal.userId, actorName: principal.displayName, action: 'created', changes });
      await tx.publish('asset.changed', assetChangedEvent(created, type, await this.kinds(tx)));
      return created;
    });
    return this.present(principal, asset, type);
  }

  /** Closes the request this new asset was bought for. Only its handlers may do this. */
  private async fulfil(tx: RegistryStore, principal: Principal, requestId: string, assetId: string): Promise<string> {
    const request = await tx.getRequest(requestId, { forUpdate: true });
    if (!request) throw AppError.validation('Unknown request');
    if (!atLeast(effectiveLevel(principal, { unitPath: request.unitPath, assetTypeId: request.assetTypeId ?? '' }), 'edit')) {
      throw AppError.forbidden('You cannot fulfil this request');
    }
    if (request.status === 'fulfilled' || request.status === 'rejected' || request.status === 'cancelled') throw AppError.conflict('The request is already closed');
    await tx.setRequestStatus(request.id, 'fulfilled', assetId);
    await tx.addRequestEvent({ requestId: request.id, actorId: principal.userId, actorName: principal.displayName, kind: 'fulfilled', body: null, fromStatus: request.status, toStatus: 'fulfilled' });
    await tx.publish('request.changed', {
      requestId: request.id,
      number: requestNumber(request.seq),
      title: request.title,
      unitId: request.unitId,
      requesterId: request.requesterId,
      assigneeId: request.assigneeId,
      status: 'fulfilled',
      previousStatus: request.status,
      actorId: principal.userId,
      actorName: principal.displayName,
      note: null,
      kind: 'fulfilled',
    });
    return requestNumber(request.seq);
  }

  async update(principal: Principal, id: string, patch: AssetUpdate): Promise<Asset> {
    return this.store.transaction(async (tx) => {
      const current = await tx.getAsset(id, { forUpdate: true });
      if (!current) throw AppError.notFound('Asset');
      const level = authorize(principal, 'edit', scopeOf(current));
      const type = (await tx.getType(current.assetTypeId))!;

      // Moving an asset to another unit needs edit rights on the destination too.
      if (patch.unitId && patch.unitId !== current.unitId) {
        authorize(principal, 'edit', { unitPath: await this.unitPath(patch.unitId, tx), assetTypeId: type.id });
      }
      await this.assertPeople(type, patch.ownerId ?? null, patch.attributes ?? {}, tx);

      const { merged, blocked } = mergeAttributes(type.fields, current.values, patch.attributes ?? {}, atLeast(level, 'manage'));
      if (blocked.length) throw AppError.forbidden(`Only managers can change: ${blocked.join(', ')}`);
      const draft: AssetDraft = {
        assetTypeId: type.id,
        typeVersion: type.version,
        name: patch.name?.trim() ?? current.name,
        status: patch.status !== undefined ? resolveStatus(type, patch.status) : current.status,
        ownerId: patch.ownerId !== undefined ? patch.ownerId : current.ownerId,
        unitId: patch.unitId ?? current.unitId,
        values: validatedValues(type, merged),
        reminderOverrides: patch.reminderOverrides ? validatedOverrides(type, patch.reminderOverrides) : current.reminderOverrides,
      };
      const changes = diff(type, current, draft);
      if (!Object.keys(changes).length) return this.present(principal, current, type);
      const saved = await tx.saveAsset(id, draft, principal.userId, await this.searchText(tx, type, draft));
      await tx.addActivity({ assetId: id, actorId: principal.userId, actorName: principal.displayName, action: 'updated', changes });
      await tx.publish('asset.changed', assetChangedEvent(saved, type, await this.kinds(tx)));
      return this.present(principal, saved, type);
    });
  }

  /** "Renewed" / "Paid": rolls a recurring date forward by its interval. */
  async advance(principal: Principal, id: string, fieldKey: string): Promise<Asset> {
    return this.store.transaction(async (tx) => {
      const current = await tx.getAsset(id, { forUpdate: true });
      if (!current) throw AppError.notFound('Asset');
      authorize(principal, 'edit', scopeOf(current));
      const type = (await tx.getType(current.assetTypeId))!;
      const kinds = await this.kinds(tx);
      const { values, from, to } = advanceRecurringDate(type, current.values, fieldKey, kinds);
      const draft: AssetDraft = { ...current, typeVersion: type.version, values };
      const saved = await tx.saveAsset(id, draft, principal.userId, await this.searchText(tx, type, draft));
      await tx.addActivity({ assetId: id, actorId: principal.userId, actorName: principal.displayName, action: 'advanced', changes: diff(type, current, draft) });
      const affected = type.fields.filter((f) => f.kind === 'date' && current.values[f.key] !== values[f.key]).map((f) => f.key);
      await tx.publish('asset.changed', assetChangedEvent(saved, type, kinds, { fieldKey, from, to, by: principal.userId, affected }));
      return this.present(principal, saved, type);
    });
  }

  async remove(principal: Principal, id: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      const current = await tx.getAsset(id, { forUpdate: true });
      if (!current) throw AppError.notFound('Asset');
      authorize(principal, 'manage', scopeOf(current));
      await tx.deleteAsset(id);
      await tx.addActivity({ assetId: id, actorId: principal.userId, actorName: principal.displayName, action: 'deleted', changes: { name: { from: current.name, to: null } } });
      await tx.publish('asset.deleted', { assetId: id });
    });
  }

  async activity(principal: Principal, id: string) {
    const asset = await this.store.getAsset(id);
    if (!asset) throw AppError.notFound('Asset');
    authorize(principal, 'view', scopeOf(asset));
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
      const type = asset && (await this.store.getType(asset.assetTypeId));
      if (asset && type) await this.store.setSearchText(id, await this.searchText(this.store, type, asset));
    }
    return ids.length;
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private async searchText(store: RegistryStore, type: AssetType, draft: AssetDraft): Promise<string> {
    const personIds = [draft.ownerId, ...type.fields.filter((f) => f.kind === 'user').map((f) => draft.values[f.key])].filter((v): v is string => typeof v === 'string');
    const assetIds = type.fields.filter((f) => f.kind === 'assetRef').map((f) => draft.values[f.key]).filter((v): v is string => typeof v === 'string');
    const unit = await store.getUnit(draft.unitId);
    const [people, assets, unitNames] = await Promise.all([store.userNames(personIds), store.assetNames(assetIds), store.unitNames(unit?.path ?? [draft.unitId])]);
    return buildSearchText(type, draft.name, draft.values, draft.ownerId ? people.get(draft.ownerId) : undefined, {
      typeName: type.name,
      statusLabel: type.statuses.find((s) => s.value === draft.status)?.label ?? draft.status,
      // The whole path, so "marketing figma" finds Figma in any Marketing team.
      unitName: (unit?.path ?? []).map((id) => unitNames.get(id)).filter(Boolean).join(' › '),
      personName: (id) => people.get(id),
      assetName: (id) => assets.get(id),
    });
  }

  private present(principal: Principal, asset: AssetState, type: AssetType): Asset {
    const access: AccessLevel = effectiveLevel(principal, scopeOf(asset));
    return {
      id: asset.id,
      assetTypeId: asset.assetTypeId,
      typeVersion: asset.typeVersion,
      name: asset.name,
      status: asset.status,
      ownerId: asset.ownerId,
      unitId: asset.unitId,
      attributes: redactAttributes(type.fields, asset.values, atLeast(access, 'manage')),
      reminderOverrides: asset.reminderOverrides,
      access,
      createdAt: asset.createdAt.toISOString(),
      updatedAt: asset.updatedAt.toISOString(),
    };
  }

  private async load(id: string) {
    const asset = await this.store.getAsset(id);
    if (!asset) throw AppError.notFound('Asset');
    return { asset, type: (await this.store.getType(asset.assetTypeId))! };
  }

  private async activeType(id: string): Promise<AssetType> {
    const type = await this.store.getType(id);
    if (!type) throw AppError.validation('Unknown asset type');
    if (type.archived) throw AppError.validation(`"${type.name}" is archived; new assets cannot be created`);
    return type;
  }

  private async typeMap(ids: string[]) {
    const map = new Map<string, AssetType>();
    for (const id of new Set(ids)) {
      const t = await this.store.getType(id);
      if (t) map.set(id, t);
    }
    return map;
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
  private async assertPeople(type: AssetType, ownerId: string | null, attributes: Record<string, unknown>, store = this.store) {
    const userKeys = type.fields.filter((f) => f.kind === 'user').map((f) => f.key);
    const ids = [ownerId, ...userKeys.map((k) => attributes[k])].filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (!ids.length) return;
    const known = await store.activeUserIds(ids);
    const unknown = ids.filter((i) => !known.has(i));
    if (unknown.length) throw AppError.validation('Unknown or inactive person selected', { users: unknown });
  }
}
