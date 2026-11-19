import type {
  ActivityEntry,
  Asset,
  AssetQuery,
  AssetType,
  AuthProviderInfo,
  DateKind,
  FileRecord,
  GrantRecord,
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
  UnitPerson,
  UnitRollup,
  User,
  UserSummary,
} from '@am/core';
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
  grants: ['grants'] as const,
  calendarFeed: ['calendar-feed'] as const,
};

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api.get<Me>('/api/identity/me'), retry: false, staleTime: 60_000 });
export const useProviders = () => useQuery({ queryKey: keys.providers, queryFn: () => api.get<AuthProviderInfo[]>('/api/identity/auth/providers') });

export const useAssetTypes = () => useQuery({ queryKey: keys.assetTypes, queryFn: () => api.get<AssetType[]>('/api/registry/asset-types'), staleTime: 30_000 });
export const useAssetType = (id: string | undefined) =>
  useQuery({ queryKey: keys.assetType(id ?? ''), queryFn: () => api.get<AssetType>(`/api/registry/asset-types/${id}`), enabled: !!id });
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
  return useMemo(() => {
    const unitById = new Map((units.data ?? []).map((u) => [u.id, u]));
    return {
      ready: !!types.data && !!kinds.data && !!units.data,
      types: types.data ?? [],
      typeById: new Map((types.data ?? []).map((t) => [t.id, t])),
      kinds: kinds.data ?? [],
      kindById: new Map((kinds.data ?? []).map((k) => [k.id, k])),
      units: units.data ?? [],
      unitById,
      /** "Wix › R&D › Editor" */
      unitPathNames: (id: string | null | undefined) => (id ? (unitById.get(id)?.path ?? []).map((p) => unitById.get(p)?.name ?? '…') : []),
      childrenOf: (id: string | null) => (units.data ?? []).filter((u) => u.parentId === id),
    };
  }, [types.data, kinds.data, units.data]);
}

export const useUsers = (q: string) => useQuery({ queryKey: keys.users(q), queryFn: () => api.get<Page<User>>('/api/identity/users', { q, limit: 200 }), placeholderData: keepPreviousData });
export const useGroups = () => useQuery({ queryKey: keys.groups, queryFn: () => api.get<Group[]>('/api/identity/groups') });
export const useGroupMembers = (id: string | null) =>
  useQuery({ queryKey: keys.groupMembers(id ?? ''), queryFn: () => api.get<UserSummary[]>(`/api/identity/groups/${id}/members`), enabled: !!id });
export const useGrants = () => useQuery({ queryKey: keys.grants, queryFn: () => api.get<GrantRecord[]>('/api/identity/grants') });

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
