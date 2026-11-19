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
  PurchaseClass,
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
  purchaseClasses: ['purchase-classes'] as const,
  people: (key: string) => ['people', key] as const,
  assets: ['assets'] as const,
  assetList: (q: Partial<AssetQuery>) => ['assets', 'list', q] as const,
  asset: (id: string) => ['assets', id] as const,
  activity: (id: string) => ['assets', id, 'activity'] as const,
  files: (assetId: string) => ['files', assetId] as const,
  obligations: ['obligations'] as const,
  obligationList: (q: Partial<ObligationQuery>) => ['obligations', 'list', q] as const,
  summary: ['obligations', 'summary'] as const,
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
export const usePurchaseClasses = () =>
  useQuery({ queryKey: keys.purchaseClasses, queryFn: () => api.get<PurchaseClass[]>('/api/identity/purchase-classes'), staleTime: 60_000 });

export const useAssets = (q: Partial<AssetQuery>) =>
  useQuery({ queryKey: keys.assetList(q), queryFn: () => api.get<Page<Asset>>('/api/registry/assets', q), placeholderData: keepPreviousData });
export const useAsset = (id: string) => useQuery({ queryKey: keys.asset(id), queryFn: () => api.get<Asset>(`/api/registry/assets/${id}`) });
export const useActivity = (id: string) => useQuery({ queryKey: keys.activity(id), queryFn: () => api.get<ActivityEntry[]>(`/api/registry/assets/${id}/activity`) });
export const useFiles = (assetId: string) => useQuery({ queryKey: keys.files(assetId), queryFn: () => api.get<FileRecord[]>(`/api/files/assets/${assetId}`) });

export const useObligations = (q: Partial<ObligationQuery>) =>
  useQuery({ queryKey: keys.obligationList(q), queryFn: () => api.get<Page<Obligation>>('/api/scheduler/obligations', q), placeholderData: keepPreviousData });
export const useSummary = () => useQuery({ queryKey: keys.summary, queryFn: () => api.get<ObligationSummary>('/api/scheduler/summary') });

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
  const classes = usePurchaseClasses();
  return useMemo(
    () => ({
      ready: !!types.data && !!kinds.data && !!classes.data,
      types: types.data ?? [],
      typeById: new Map((types.data ?? []).map((t) => [t.id, t])),
      kinds: kinds.data ?? [],
      kindById: new Map((kinds.data ?? []).map((k) => [k.id, k])),
      classes: classes.data ?? [],
      classById: new Map((classes.data ?? []).map((c) => [c.id, c])),
    }),
    [types.data, kinds.data, classes.data],
  );
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
    // The scheduler updates asynchronously from events; refetch shortly after.
    setTimeout(() => void qc.invalidateQueries({ queryKey: keys.obligations }), 1500);
  };
}
