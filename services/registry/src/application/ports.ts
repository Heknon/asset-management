import type { ActivityEntry, AssetQuery, AssetType, AssetTypeInput, DateKind, DateKindInput, EventMap, EventName, Scope } from '@am/core';
import type { AssetDraft, AssetState } from '../domain/asset.js';

export interface RegistryStore {
  transaction<T>(fn: (store: RegistryStore) => Promise<T>): Promise<T>;

  listDateKinds(): Promise<DateKind[]>;
  createDateKind(input: DateKindInput): Promise<DateKind>;
  updateDateKind(id: string, input: DateKindInput & { archived: boolean }): Promise<DateKind>;

  listTypes(includeArchived: boolean): Promise<AssetType[]>;
  getType(id: string): Promise<AssetType | null>;
  createType(input: AssetTypeInput): Promise<AssetType>;
  /** Saves a new schema version; returns the updated type. */
  updateType(id: string, input: AssetTypeInput, expectedVersion: number): Promise<AssetType>;
  setTypeArchived(id: string, archived: boolean): Promise<AssetType>;
  countAssetsOfType(id: string): Promise<number>;

  /** Assets visible within the given scopes (empty scopes ⇒ nothing). */
  queryAssets(query: AssetQuery, scopes: Scope[]): Promise<{ items: AssetState[]; total: number }>;
  getAsset(id: string, opts?: { forUpdate?: boolean }): Promise<AssetState | null>;
  insertAsset(draft: AssetDraft, actorId: string): Promise<AssetState>;
  saveAsset(id: string, draft: AssetDraft, actorId: string): Promise<AssetState>;
  deleteAsset(id: string): Promise<void>;
  assetIdsOfTypes(typeIds: string[]): Promise<string[]>;

  addActivity(entry: Omit<ActivityEntry, 'id' | 'at'>): Promise<void>;
  listActivity(assetId: string, limit: number): Promise<ActivityEntry[]>;

  purchaseClassExists(id: string): Promise<boolean>;
  upsertPurchaseClassRef(ref: { id: string; key: string; name: string; archived: boolean }): Promise<void>;
  activeUserIds(ids: string[]): Promise<Set<string>>;
  upsertUserRef(ref: { id: string; displayName: string; active: boolean }): Promise<void>;

  publish<E extends EventName>(event: E, payload: EventMap[E]): Promise<void>;
}
