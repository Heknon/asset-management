import type {
  ActivityEntry,
  Asset,
  AssetComment,
  Catalog,
  CatalogQuery,
  AssetQuery,
  AssetType,
  AuthProviderInfo,
  DateKind,
  FileRecord,
  Group,
  Me,
  Obligation,
  ObligationQuery,
  ObligationSummary,
  Page,
  OrgUnit,
  PurchaseRequest,
  RequestCounts,
  RequestEvent,
  RequestQuery,
  SavedView,
  SearchHit,
  TypeVariant,
  UnitPerson,
  UnitRollup,
  User,
  UserSummary,
  Workflow,
} from '@am/core';
import { getLocale, tMaybe } from './i18n';
import { withVariant } from '@am/core';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from './api';

/** Every query key lives here so invalidation is consistent across screens. */
export const keys = {
  me: ['me'] as const,
  providers: ['providers'] as const,
  assetTypes: ['asset-types'] as const,
  assetType: (id: string) => ['asset-types', id] as const,
  dateKinds: ['date-kinds'] as const,
  workflow: ['workflow'] as const,
  purchaseUnit: ['workflow', 'purchase-unit'] as const,
  templates: ['templates'] as const,
  units: ['units'] as const,
  unitPeople: (id: string) => ['units', id, 'people'] as const,
  rollup: (id: string) => ['obligations', 'rollup', id] as const,
  requests: ['requests'] as const,
  requestList: (q: Partial<RequestQuery>) => ['requests', 'list', q] as const,
  request: (id: string) => ['requests', id] as const,
  requestEvents: (id: string) => ['requests', id, 'events'] as const,
  requestCounts: ['requests', 'counts'] as const,
  assetRequest: (assetId: string) => ['requests', 'asset', assetId] as const,
  views: ['views'] as const,
  search: (q: string) => ['search', q] as const,
  people: (key: string) => ['people', key] as const,
  assets: ['assets'] as const,
  assetList: (q: Partial<AssetQuery>) => ['assets', 'list', q] as const,
  asset: (id: string) => ['assets', id] as const,
  activity: (id: string) => ['assets', id, 'activity'] as const,
  files: (assetId: string) => ['files', assetId] as const,
  obligations: ['obligations'] as const,
  obligationList: (q: Partial<ObligationQuery>) => ['obligations', 'list', q] as const,
  summary: (q: { unitId?: string; mine?: boolean } = {}) => ['obligations', 'summary', q] as const,
  users: (q: string) => ['users', q] as const,
  groups: ['groups'] as const,
  groupMembers: (id: string) => ['groups', id, 'members'] as const,
  calendarFeed: ['calendar-feed'] as const,
  features: ['features'] as const,
  variants: ['variants'] as const,
  catalogs: ['catalogs'] as const,
  catalogList: (q: Partial<CatalogQuery>) => ['catalogs', 'list', q] as const,
  catalog: (id: string) => ['catalogs', id] as const,
  comments: (assetId: string) => ['assets', assetId, 'comments'] as const,
};

export interface Features {
  csvExport: boolean;
}
export const useFeatures = () => useQuery({ queryKey: keys.features, queryFn: () => api.get<Features>('/api/registry/features'), staleTime: 300_000 });

/** Every team variant (few; used to render any item with its extra fields). */
export const useVariants = () => useQuery({ queryKey: keys.variants, queryFn: () => api.get<TypeVariant[]>('/api/registry/variants', { archived: true }), staleTime: 30_000 });

export const useCatalogs = (q: Partial<CatalogQuery> = {}) => useQuery({ queryKey: keys.catalogList(q), queryFn: () => api.get<Catalog[]>('/api/registry/catalogs', q), staleTime: 30_000 });
export const useCatalog = (id: string | null | undefined) =>
  useQuery({ queryKey: keys.catalog(id ?? ''), queryFn: () => api.get<Catalog>(`/api/registry/catalogs/${id}`), enabled: !!id, retry: false });
export const useComments = (assetId: string) =>
  useQuery({ queryKey: keys.comments(assetId), queryFn: () => api.get<AssetComment[]>(`/api/registry/assets/${assetId}/comments`), refetchInterval: 30_000 });

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api.get<Me>('/api/identity/me'), retry: false, staleTime: 60_000 });
export const useProviders = () => useQuery({ queryKey: keys.providers, queryFn: () => api.get<AuthProviderInfo[]>('/api/identity/auth/providers') });

/**
 * Built-in names (from the starter templates: "Software license", "Vendor", "Commercial",
 * "Active"…) shown in the app's language. Only for display: the template editor reads the
 * stored names through useAssetType, so nothing translated is ever saved. Names people
 * typed themselves have no translation and show as they are.
 */
function localizeType(type: AssetType): AssetType {
  return {
    ...type,
    name: tMaybe(type.name),
    description: type.description ? tMaybe(type.description) : type.description,
    sections: type.sections.map(tMaybe),
    statuses: type.statuses.map((st) => ({ ...st, label: tMaybe(st.label) })),
    fields: type.fields.map((f) => ({
      ...f,
      label: tMaybe(f.label),
      ...(f.section && { section: tMaybe(f.section) }),
      ...(f.description && { description: tMaybe(f.description) }),
      ...('options' in (f.config ?? {}) && {
        config: { ...f.config, options: (f.config as { options: Array<{ value: string; label: string }> }).options.map((o) => ({ ...o, label: tMaybe(o.label) })) },
      }),
    })) as AssetType['fields'],
  };
}

const localizeTypes = (types: AssetType[]) => (getLocale() === 'en' ? types : types.map(localizeType));

export const useAssetTypes = () =>
  useQuery({
    queryKey: keys.assetTypes,
    queryFn: () => api.get<AssetType[]>('/api/registry/asset-types'),
    staleTime: 30_000,
    select: localizeTypes,
  });
export const useAssetType = (id: string | undefined) =>
  useQuery({ queryKey: keys.assetType(id ?? ''), queryFn: () => api.get<AssetType>(`/api/registry/asset-types/${id}`), enabled: !!id });
/** The unit responsible for purchases (null: whoever may renew). */
export const usePurchaseUnit = () => useQuery({ queryKey: keys.purchaseUnit, queryFn: () => api.get<{ unitId: string | null }>('/api/registry/workflows/purchase-unit'), staleTime: 60_000 });
export const useOrgWorkflow = () => useQuery({ queryKey: keys.workflow, queryFn: () => api.get<Workflow>('/api/registry/workflows/default'), staleTime: 60_000 });
export const useDateKinds = () => useQuery({ queryKey: keys.dateKinds, queryFn: () => api.get<DateKind[]>('/api/registry/date-kinds'), staleTime: 60_000 });
export const useUnits = () => useQuery({ queryKey: keys.units, queryFn: () => api.get<OrgUnit[]>('/api/identity/units'), staleTime: 60_000 });
export const useUnitPeople = (id: string | null) =>
  useQuery({ queryKey: keys.unitPeople(id ?? ''), queryFn: () => api.get<UnitPerson[]>(`/api/identity/units/${id}/people`), enabled: !!id });
export const useRollup = (id: string) => useQuery({ queryKey: keys.rollup(id), queryFn: () => api.get<UnitRollup[]>(`/api/scheduler/units/${id}/rollup`) });

export const useRequests = (q: Partial<RequestQuery>) =>
  useQuery({ queryKey: keys.requestList(q), queryFn: () => api.get<Page<PurchaseRequest>>('/api/registry/requests', q), placeholderData: keepPreviousData });
export const useRequest = (id: string) => useQuery({ queryKey: keys.request(id), queryFn: () => api.get<PurchaseRequest>(`/api/registry/requests/${id}`) });
export const useRequestEvents = (id: string) => useQuery({ queryKey: keys.requestEvents(id), queryFn: () => api.get<RequestEvent[]>(`/api/registry/requests/${id}/events`) });
export const useRequestCounts = () => useQuery({ queryKey: keys.requestCounts, queryFn: () => api.get<RequestCounts>('/api/registry/requests/counts'), refetchInterval: 60_000 });
export const useAssetRequest = (assetId: string) =>
  useQuery({ queryKey: keys.assetRequest(assetId), queryFn: async () => ((r) => ('id' in r ? r : null))(await api.get<PurchaseRequest | Record<string, never>>(`/api/registry/assets/${assetId}/request`)) });
export const useViews = () => useQuery({ queryKey: keys.views, queryFn: () => api.get<SavedView[]>('/api/registry/views'), staleTime: 60_000 });
export const useSearch = (q: string, limit = 8) =>
  useQuery({ queryKey: [...keys.search(q), limit], queryFn: () => api.get<SearchHit[]>('/api/registry/search', { q, limit }), enabled: q.trim().length > 0, placeholderData: keepPreviousData });

export const useAssets = (q: Partial<AssetQuery>) =>
  useQuery({ queryKey: keys.assetList(q), queryFn: () => api.get<Page<Asset>>('/api/registry/assets', q), placeholderData: keepPreviousData });
export const useAsset = (id: string) => useQuery({ queryKey: keys.asset(id), queryFn: () => api.get<Asset>(`/api/registry/assets/${id}`) });
export const useActivity = (id: string) => useQuery({ queryKey: keys.activity(id), queryFn: () => api.get<ActivityEntry[]>(`/api/registry/assets/${id}/activity`) });
export const useFiles = (assetId: string) => useQuery({ queryKey: keys.files(assetId), queryFn: () => api.get<FileRecord[]>(`/api/files/assets/${assetId}`) });

export const useObligations = (q: Partial<ObligationQuery>) =>
  useQuery({ queryKey: keys.obligationList(q), queryFn: () => api.get<Page<Obligation>>('/api/scheduler/obligations', q), placeholderData: keepPreviousData });
export const useSummary = (q: { unitId?: string; mine?: boolean } = {}) =>
  useQuery({ queryKey: keys.summary(q), queryFn: () => api.get<ObligationSummary>('/api/scheduler/summary', q) });

/** Resolves user ids to people; results are cached per id set. */
export function usePeople(ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))].sort();
  const q = useQuery({
    queryKey: keys.people(unique.join(',')),
    queryFn: () => api.get<UserSummary[]>('/api/identity/people', { ids: unique.join(',') }),
    enabled: unique.length > 0,
    staleTime: 300_000,
  });
  return useMemo(() => new Map((q.data ?? []).map((p) => [p.id, p])), [q.data]);
}

export const usePeopleSearch = (q: string) =>
  useQuery({ queryKey: keys.people(`q:${q}`), queryFn: () => api.get<UserSummary[]>('/api/identity/people', { q }), placeholderData: keepPreviousData });

/** Lookup maps used by most screens. */
export function useLookups() {
  const types = useAssetTypes();
  const kinds = useDateKinds();
  const units = useUnits();
  const variants = useVariants();
  return useMemo(() => {
    const unitById = new Map((units.data ?? []).map((u) => [u.id, u]));
    const typeById = new Map((types.data ?? []).map((t) => [t.id, t]));
    const variantById = new Map((variants.data ?? []).map((v) => [v.id, v]));
    return {
      ready: !!types.data && !!kinds.data && !!units.data && !!variants.data,
      types: types.data ?? [],
      typeById,
      variants: variants.data ?? [],
      variantById,
      /** Variants usable for items of a unit (the unit's own and its ancestors'). */
      variantsFor: (typeId: string, unitId: string | null | undefined) => {
        const path = unitId ? (unitById.get(unitId)?.path ?? []) : [];
        return (variants.data ?? []).filter((v) => v.assetTypeId === typeId && !v.archived && path.includes(v.unitId));
      },
      /** What an item follows: its template plus its variant's fields (named after the variant). */
      schemaOf: (typeId: string, variantId: string | null | undefined) => {
        const t = typeById.get(typeId);
        const v = variantId ? variantById.get(variantId) : undefined;
        return t && v ? { ...withVariant(t, v), name: v.name } : t;
      },
      kinds: kinds.data ?? [],
      kindById: new Map((kinds.data ?? []).map((k) => [k.id, k])),
      units: units.data ?? [],
      unitById,
      /** "Wix › R&D › Editor" */
      unitPathNames: (id: string | null | undefined) => (id ? (unitById.get(id)?.path ?? []).map((p) => unitById.get(p)?.name ?? '…') : []),
      childrenOf: (id: string | null) => (units.data ?? []).filter((u) => u.parentId === id),
    };
  }, [types.data, kinds.data, units.data, variants.data]);
}

export const useUsers = (q: string) => useQuery({ queryKey: keys.users(q), queryFn: () => api.get<Page<User>>('/api/identity/users', { q, limit: 200 }), placeholderData: keepPreviousData });
export const useGroups = () => useQuery({ queryKey: keys.groups, queryFn: () => api.get<Group[]>('/api/identity/groups') });
export const useGroupMembers = (id: string | null) =>
  useQuery({ queryKey: keys.groupMembers(id ?? ''), queryFn: () => api.get<UserSummary[]>(`/api/identity/groups/${id}/members`), enabled: !!id });

/** After any asset mutation the asset, its lists and its obligations change together. */
export function useInvalidateAssets() {
  const qc = useQueryClient();
  return (assetId?: string) => {
    void qc.invalidateQueries({ queryKey: keys.assets });
    if (assetId) void qc.invalidateQueries({ queryKey: keys.asset(assetId) });
    void qc.invalidateQueries({ queryKey: keys.requests });
    // The scheduler updates asynchronously from events; refetch shortly after.
    setTimeout(() => void qc.invalidateQueries({ queryKey: keys.obligations }), 1500);
  };
}
