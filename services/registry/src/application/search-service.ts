import { foldText, searchTerms, type Principal, type SavedViewInput, type SearchHit } from '@am/core';
import type { AssetService } from './asset-service.js';
import type { RegistryStore } from './ports.js';
import type { RequestService } from './request-service.js';

/** Quick search across what the registry owns, plus the caller's saved views. */
export class SearchService {
  constructor(
    private readonly store: RegistryStore,
    private readonly assets: AssetService,
    private readonly requests: RequestService,
  ) {}

  async search(p: Principal, q: string, limit: number): Promise<SearchHit[]> {
    const [assets, requests, types] = await Promise.all([
      this.assets.list(p, { q, limit, offset: 0, sort: 'relevance', order: 'desc', includeSubunits: true, filters: [] }),
      this.requests.list(p, { q, scope: 'all', status: 'all', limit: Math.min(limit, 5), offset: 0 }),
      this.store.listTypes(false),
    ]);
    const terms = searchTerms(q);
    const typeHits: SearchHit[] = types
      .filter((t) => terms.every((term) => foldText(`${t.name} ${t.description ?? ''}`).includes(term)))
      .slice(0, 3)
      .map((t) => ({ kind: 'type', id: t.id, title: t.name, subtitle: t.description ?? null, snippet: null }));
    const typeName = new Map(types.map((t) => [t.id, t.name]));
    return [
      ...assets.items.map(
        (a): SearchHit => ({ kind: 'asset', id: a.id, title: a.name, subtitle: typeName.get(a.assetTypeId) ?? null, snippet: a.snippet ?? null, assetTypeId: a.assetTypeId, unitId: a.unitId }),
      ),
      ...requests.items.map((r): SearchHit => ({ kind: 'request', id: r.id, title: r.title, subtitle: `${r.number} · ${r.status.replace('_', ' ')}`, snippet: r.snippet ?? null, unitId: r.unitId })),
      ...typeHits,
    ];
  }

  views(p: Principal) {
    return this.store.listViews(p.userId);
  }
  createView(p: Principal, input: SavedViewInput) {
    return this.store.createView(p.userId, input);
  }
  updateView(p: Principal, id: string, input: SavedViewInput) {
    return this.store.updateView(p.userId, id, input);
  }
  deleteView(p: Principal, id: string) {
    return this.store.deleteView(p.userId, id);
  }
}
