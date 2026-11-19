import type {
  AccessLevel,
  ActivityEntry,
  AssetComment,
  AssetQuery,
  CatalogInput,
  AssetType,
  AssetTypeInput,
  DateKind,
  DateKindInput,
  EventMap,
  EventName,
  RequestEvent,
  RequestQuery,
  RequestStatus,
  SavedView,
  SavedViewInput,
  Scope,
  ShareLevel,
  Visibility,
} from '@am/core';
import type { CatalogState } from '../domain/catalog.js';
import type { AssetDraft, AssetState } from '../domain/asset.js';
import type { RequestState } from '../domain/request.js';

export interface UnitRef {
  id: string;
  key: string;
  name: string;
  kind: string;
  parentId: string | null;
  path: string[];
  archived: boolean;
}

export interface SearchOptions {
  /** Free text: every term must match (prefix), with substring and typo-tolerant fallbacks. */
  q?: string;
}

export interface RequestRow {
  title: string;
  description: string;
  unitId: string;
  assetTypeId: string | null;
  quantity: number | null;
  estimatedCost: { amount: number; currency: string } | null;
  neededBy: string | null;
  link: string | null;
}

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

  /** Assets the visibility allows (org scopes or catalog shares), with search snippets when `q` is set. */
  queryAssets(query: AssetQuery, visibility: Visibility, type: AssetType | null): Promise<{ items: Array<AssetState & { snippet?: string }>; total: number }>;
  /** The asset types present in a query's results (CSV columns). */
  assetTypeIdsIn(query: AssetQuery, visibility: Visibility): Promise<string[]>;
  /** The best level any of these share keys has on the catalog ('none' when not shared with them). */
  catalogShareLevel(catalogId: string | null, shareKeys: readonly string[]): Promise<AccessLevel>;
  getAsset(id: string, opts?: { forUpdate?: boolean }): Promise<AssetState | null>;
  insertAsset(draft: AssetDraft, actorId: string, searchText: string): Promise<AssetState>;
  saveAsset(id: string, draft: AssetDraft, actorId: string, searchText: string): Promise<AssetState>;
  setSearchText(id: string, searchText: string): Promise<void>;
  deleteAsset(id: string): Promise<void>;
  assetIdsOfTypes(typeIds: string[]): Promise<string[]>;
  /** Assets whose search text must be rebuilt: in these units or beneath them, owned by / referencing these people, or never indexed. */
  assetIdsToReindex(where: { unitIds?: string[]; userIds?: string[]; unindexed?: boolean }): Promise<string[]>;
  assetNames(ids: string[]): Promise<Map<string, string>>;

  addActivity(entry: Omit<ActivityEntry, 'id' | 'at'>): Promise<void>;
  listActivity(assetId: string, limit: number): Promise<ActivityEntry[]>;

  getUnit(id: string): Promise<UnitRef | null>;
  unitPaths(ids: string[]): Promise<Map<string, string[]>>;
  unitNames(ids: string[]): Promise<Map<string, string>>;
  upsertUnitRef(ref: UnitRef): Promise<void>;
  activeUserIds(ids: string[]): Promise<Set<string>>;
  userNames(ids: string[]): Promise<Map<string, string>>;
  upsertUserRef(ref: { id: string; displayName: string; active: boolean }): Promise<{ renamed: boolean }>;

  insertRequest(row: RequestRow, requester: { id: string; name: string }, searchText: string): Promise<RequestState>;
  updateRequest(id: string, row: RequestRow, searchText: string): Promise<RequestState>;
  getRequest(id: string, opts?: { forUpdate?: boolean }): Promise<RequestState | null>;
  setRequestStatus(id: string, status: RequestStatus, assetId?: string | null): Promise<void>;
  setRequestAssignee(id: string, assigneeId: string | null): Promise<void>;
  queryRequests(
    q: RequestQuery,
    visibility: { userId: string; viewScopes: Scope[]; editScopes: Scope[]; myUnitIds: string[] },
  ): Promise<{ items: Array<RequestState & { snippet?: string }>; total: number }>;
  countRequests(visibility: { userId: string; viewScopes: Scope[]; editScopes: Scope[]; myUnitIds: string[] }): Promise<{ mine: number; team: number; handle: number; unassigned: number }>;
  addRequestEvent(e: Omit<RequestEvent, 'id' | 'at'>): Promise<void>;
  listRequestEvents(requestId: string): Promise<RequestEvent[]>;
  requestForAsset(assetId: string): Promise<RequestState | null>;

  getCatalog(id: string, opts?: { forUpdate?: boolean }): Promise<CatalogState | null>;
  /** Catalogs whose unit is within the org scopes (type-agnostic), or shared with one of the keys. */
  listCatalogs(where: { unitScopes: Scope[]; shareKeys: readonly string[]; unitId?: string; only?: 'owned' | 'shared' }): Promise<CatalogState[]>;
  insertCatalog(input: CatalogInput, actor: { id: string; name: string }): Promise<CatalogState>;
  updateCatalog(id: string, input: Omit<CatalogInput, 'unitId'>): Promise<CatalogState>;
  /** Bumps the version (after a share change) so consumers can order events. */
  touchCatalog(id: string): Promise<CatalogState>;
  deleteCatalog(id: string): Promise<void>;
  assetIdsInCatalog(id: string): Promise<string[]>;
  /** Takes assets out of a catalog (it is being deleted); returns the updated assets. */
  unfileAssets(catalogId: string, actorId: string): Promise<AssetState[]>;
  putShare(catalogId: string, subjectKey: string, level: ShareLevel, byName: string): Promise<void>;
  removeShare(catalogId: string, subjectKey: string): Promise<boolean>;
  unitsExist(ids: string[]): Promise<Set<string>>;

  listComments(assetId: string): Promise<AssetComment[]>;
  getComment(id: string): Promise<AssetComment | null>;
  /** Null when `sourceKey` was already posted (event redelivery). */
  insertComment(c: Pick<AssetComment, 'assetId' | 'authorId' | 'authorName' | 'body' | 'mentionIds'> & { kind?: AssetComment['kind']; sourceKey?: string }): Promise<AssetComment | null>;
  updateComment(id: string, patch: { body: string; mentionIds: string[] } | { deleted: true }): Promise<AssetComment>;
  commentCounts(assetIds: string[]): Promise<Map<string, number>>;

  listViews(ownerId: string): Promise<SavedView[]>;
  createView(ownerId: string, input: SavedViewInput): Promise<SavedView>;
  updateView(ownerId: string, id: string, input: SavedViewInput): Promise<SavedView>;
  deleteView(ownerId: string, id: string): Promise<void>;

  publish<E extends EventName>(event: E, payload: EventMap[E]): Promise<void>;
}
