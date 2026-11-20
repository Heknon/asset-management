import { foldText, searchTerms, type OrgUnit, type SearchHit, type UserSummary } from '@am/core';
import { useMemo } from 'react';
import { tMaybe } from './i18n';
import { useLookups, usePeopleSearch, useSearch } from './queries';

/**
 * One search for the palette and the results page: assets, requests and
 * types from the registry, plus teams (client-side over the org tree) and
 * people from the directory.
 */
export function useUniversalSearch(q: string, limit = 8) {
  const query = q.trim();
  const registry = useSearch(query, limit);
  const people = usePeopleSearch(query.length >= 2 ? query : '');
  const { units, unitPathNames } = useLookups();

  return useMemo(() => {
    const terms = searchTerms(query);
    const unitHits: SearchHit[] = terms.length
      ? units
          .filter((u: OrgUnit) => !u.archived && terms.every((t) => foldText(unitPathNames(u.id).join(' ')).includes(t)))
          .sort((a, b) => a.path.length - b.path.length)
          .slice(0, limit)
          .map((u) => ({ kind: 'unit', id: u.id, title: u.name, subtitle: unitPathNames(u.id).slice(0, -1).join(' › ') || tMaybe(u.kind), snippet: null, unitId: u.id }))
      : [];
    const personHits: SearchHit[] =
      query.length >= 2
        ? (people.data ?? []).slice(0, limit).map((p: UserSummary) => ({ kind: 'person', id: p.id, title: p.displayName, subtitle: p.email ?? p.username, snippet: null }))
        : [];
    const hits = registry.data ?? [];
    return {
      loading: registry.isFetching,
      assets: hits.filter((h) => h.kind === 'asset'),
      requests: hits.filter((h) => h.kind === 'request'),
      types: hits.filter((h) => h.kind === 'type'),
      units: unitHits,
      people: personHits,
      empty: !!query && !registry.isFetching && !hits.length && !unitHits.length && !personHits.length,
    };
  }, [query, registry.data, registry.isFetching, people.data, units, unitPathNames, limit]);
}
