import {
  advanceRecurringDate,
  AppError,
  atLeast,
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
import { assetChangedEvent, diff, resolveStatus, validatedOverrides, validatedValues, type AssetDraft, type AssetState } from '../domain/asset.js';
import type { RegistryStore } from './ports.js';

export class AssetService {
  constructor(private readonly store: RegistryStore) {}

  async list(principal: Principal, query: AssetQuery): Promise<Page<Asset>> {
    const scopes = scopesFor(principal, 'view');
    const { items, total } = scopes.length ? await this.store.queryAssets(query, scopes) : { items: [], total: 0 };
    const types = await this.typeMap(items.map((a) => a.assetTypeId));
    return { items: items.map((a) => this.present(principal, a, types.get(a.assetTypeId)!)), total, limit: query.limit, offset: query.offset };
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
    return { assetId: asset.id, assetTypeId: asset.assetTypeId, purchaseClassId: asset.purchaseClassId, level };
  }

  async create(principal: Principal, input: AssetCreate): Promise<Asset> {
    const type = await this.activeType(input.assetTypeId);
    const level = authorize(principal, 'edit', { purchaseClassId: input.purchaseClassId, assetTypeId: type.id });
    await this.assertReferences(input.purchaseClassId, type, input.ownerId, input.attributes);
    const { merged, blocked } = mergeAttributes(type.fields, {}, input.attributes, atLeast(level, 'manage'));
    if (blocked.length) throw AppError.forbidden(`Only managers can set: ${blocked.join(', ')}`);

    const draft: AssetDraft = {
      assetTypeId: type.id,
      typeVersion: type.version,
      name: input.name.trim(),
      status: resolveStatus(type, input.status),
      ownerId: input.ownerId ?? principal.userId,
      purchaseClassId: input.purchaseClassId,
      values: validatedValues(type, merged),
      reminderOverrides: validatedOverrides(type, input.reminderOverrides),
    };
    const asset = await this.store.transaction(async (tx) => {
      const created = await tx.insertAsset(draft, principal.userId);
      await tx.addActivity({ assetId: created.id, actorId: principal.userId, actorName: principal.displayName, action: 'created', changes: diff(type, null, draft) });
      await tx.publish('asset.changed', assetChangedEvent(created, type, await this.kinds(tx)));
      return created;
    });
    return this.present(principal, asset, type);
  }

  async update(principal: Principal, id: string, patch: AssetUpdate): Promise<Asset> {
    return this.store.transaction(async (tx) => {
      const current = await tx.getAsset(id, { forUpdate: true });
      if (!current) throw AppError.notFound('Asset');
      const level = authorize(principal, 'edit', scopeOf(current));
      const type = (await tx.getType(current.assetTypeId))!;

      // Moving an asset to another purchase class needs edit rights on the destination too.
      if (patch.purchaseClassId && patch.purchaseClassId !== current.purchaseClassId) {
        authorize(principal, 'edit', { purchaseClassId: patch.purchaseClassId, assetTypeId: type.id });
      }
      await this.assertReferences(patch.purchaseClassId ?? current.purchaseClassId, type, patch.ownerId ?? null, patch.attributes ?? {}, tx);

      const { merged, blocked } = mergeAttributes(type.fields, current.values, patch.attributes ?? {}, atLeast(level, 'manage'));
      if (blocked.length) throw AppError.forbidden(`Only managers can change: ${blocked.join(', ')}`);
      const draft: AssetDraft = {
        assetTypeId: type.id,
        typeVersion: type.version,
        name: patch.name?.trim() ?? current.name,
        status: patch.status !== undefined ? resolveStatus(type, patch.status) : current.status,
        ownerId: patch.ownerId !== undefined ? patch.ownerId : current.ownerId,
        purchaseClassId: patch.purchaseClassId ?? current.purchaseClassId,
        values: validatedValues(type, merged),
        reminderOverrides: patch.reminderOverrides ? validatedOverrides(type, patch.reminderOverrides) : current.reminderOverrides,
      };
      const changes = diff(type, current, draft);
      if (!Object.keys(changes).length) return this.present(principal, current, type);
      const saved = await tx.saveAsset(id, draft, principal.userId);
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
      const saved = await tx.saveAsset(id, draft, principal.userId);
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

  // ─── helpers ─────────────────────────────────────────────────────────────

  private present(principal: Principal, asset: AssetState, type: AssetType): Asset {
    const access: AccessLevel = effectiveLevel(principal, scopeOf(asset));
    return {
      id: asset.id,
      assetTypeId: asset.assetTypeId,
      typeVersion: asset.typeVersion,
      name: asset.name,
      status: asset.status,
      ownerId: asset.ownerId,
      purchaseClassId: asset.purchaseClassId,
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

  /** Purchase class and people referenced by an asset must exist (via local projections). */
  private async assertReferences(purchaseClassId: string, type: AssetType, ownerId: string | null, attributes: Record<string, unknown>, store = this.store) {
    if (!(await store.purchaseClassExists(purchaseClassId))) throw AppError.validation('Unknown or archived purchase class');
    const userKeys = type.fields.filter((f) => f.kind === 'user').map((f) => f.key);
    const ids = [ownerId, ...userKeys.map((k) => attributes[k])].filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (!ids.length) return;
    const known = await store.activeUserIds(ids);
    const unknown = ids.filter((i) => !known.has(i));
    if (unknown.length) throw AppError.validation('Unknown or inactive person selected', { users: unknown });
  }
}

const scopeOf = (a: Pick<AssetState, 'purchaseClassId' | 'assetTypeId'>) => ({ purchaseClassId: a.purchaseClassId, assetTypeId: a.assetTypeId });
