import {
  AppError,
  assetTypeInputSchema,
  dateKindInputSchema,
  instantiateTemplate,
  starterTemplates,
  validateTypeStructure,
  type AssetType,
  type AssetTypeInput,
  type DateKind,
  type DateKindInput,
} from '@am/core';
import { assetChangedEvent } from '../domain/asset.js';
import type { RegistryStore } from './ports.js';

export interface TemplateSummary {
  key: string;
  name: string;
  description?: string;
  icon: string;
  color: string;
  fieldCount: number;
  trackedDates: string[];
}

/** Asset types (templates), date kinds and the starter template gallery. */
export class TypeService {
  constructor(private readonly store: RegistryStore) {}

  listDateKinds() {
    return this.store.listDateKinds();
  }

  async createDateKind(input: DateKindInput): Promise<DateKind> {
    return this.store.createDateKind(dateKindInputSchema.parse(input));
  }

  /** Kind semantics feed every tracked date using it, so affected assets are re-published. */
  async updateDateKind(id: string, input: DateKindInput & { archived: boolean }): Promise<DateKind> {
    return this.store.transaction(async (tx) => {
      const kind = await tx.updateDateKind(id, input);
      const types = (await tx.listTypes(true)).filter((t) => t.fields.some((f) => f.kind === 'date' && f.config.tracking?.dateKindId === id));
      await republishAssets(tx, types.map((t) => t.id));
      return kind;
    });
  }

  listTypes(includeArchived = false) {
    return this.store.listTypes(includeArchived);
  }

  async getType(id: string): Promise<AssetType> {
    const type = await this.store.getType(id);
    if (!type) throw AppError.notFound('Asset type');
    return type;
  }

  async createType(input: AssetTypeInput): Promise<AssetType> {
    const parsed = await this.validated(input);
    return this.store.createType(parsed);
  }

  /**
   * Schema changes are versioned. Existing values stay stored; values that no
   * longer fit surface as validation errors the next time the asset is edited.
   */
  async updateType(id: string, input: AssetTypeInput, expectedVersion: number): Promise<AssetType> {
    const parsed = await this.validated(input);
    return this.store.transaction(async (tx) => {
      const type = await tx.updateType(id, parsed, expectedVersion);
      await republishAssets(tx, [id]);
      return type;
    });
  }

  async setArchived(id: string, archived: boolean): Promise<AssetType> {
    return this.store.setTypeArchived(id, archived);
  }

  templates(): TemplateSummary[] {
    return starterTemplates.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      icon: t.icon,
      color: t.color,
      fieldCount: t.fields.length,
      trackedDates: t.fields.filter((f) => f.tracking).map((f) => f.label),
    }));
  }

  /** Creates an ordinary, fully editable asset type from a starter template. */
  async createFromTemplate(templateKey: string): Promise<AssetType> {
    const template = starterTemplates.find((t) => t.key === templateKey);
    if (!template) throw AppError.notFound('Template');
    const kinds = await this.store.listDateKinds();
    const input = instantiateTemplate(template, new Map(kinds.map((k) => [k.key, k.id])));
    const existing = new Set((await this.store.listTypes(true)).map((t) => t.key));
    let key = input.key;
    for (let i = 2; existing.has(key); i++) key = `${input.key}_${i}`;
    return this.createType({ ...input, key, name: key === input.key ? input.name : `${input.name} (${key.split('_').pop()})` });
  }

  private async validated(input: AssetTypeInput): Promise<AssetTypeInput> {
    const parsed = assetTypeInputSchema.parse(input);
    const kinds = await this.store.listDateKinds();
    const issues = validateTypeStructure(parsed, new Set(kinds.map((k) => k.id)));
    if (issues.length) throw AppError.validation('The template has problems', { issues });
    return parsed;
  }
}

/** Re-emits `asset.changed` for every asset of the given types (after schema or kind changes). */
export async function republishAssets(store: RegistryStore, typeIds: string[]): Promise<void> {
  if (!typeIds.length) return;
  const kinds = new Map((await store.listDateKinds()).map((k) => [k.id, k]));
  const types = new Map<string, AssetType>();
  for (const id of typeIds) {
    const t = await store.getType(id);
    if (t) types.set(id, t);
  }
  for (const assetId of await store.assetIdsOfTypes(typeIds)) {
    const asset = await store.getAsset(assetId);
    const type = asset && types.get(asset.assetTypeId);
    if (asset && type) await store.publish('asset.changed', assetChangedEvent(asset, type, kinds));
  }
}
