import {
  AppError,
  attributeText,
  CSV_BOM,
  csvLine,
  EXPORT_ROW_LIMIT,
  isRestricted,
  scopesFor,
  type Asset,
  type AssetExportQuery,
  type AssetType,
  type FieldDefinition,
  type Principal,
} from '@am/core';
import type { AccessResolver } from './access.js';
import type { AssetService } from './asset-service.js';
import type { RegistryStore } from './ports.js';

const PAGE = 500;

interface Column {
  header: string;
  value: (a: Asset, n: Names) => unknown;
}

interface Names {
  person: (id: string) => string | undefined;
  asset: (id: string) => string | undefined;
  unitPath: (unitId: string) => string;
  catalog: (id: string) => string | undefined;
}

/**
 * CSV export of exactly what a table shows (same filters, search and sort),
 * across all pages. It goes through the normal listing, so visibility and
 * redaction are identical: you can only export what you can see, and
 * restricted values only if you manage them.
 */
export class ExportService {
  constructor(
    private readonly store: RegistryStore,
    private readonly assets: AssetService,
    private readonly access: AccessResolver,
  ) {}

  /** Refuses up front when the caller may export nothing at all (rather than sending an empty file). */
  async assertCanExport(p: Principal): Promise<void> {
    const v = await this.access.visibility(p, 'export');
    if (v.scopes.length || (await this.store.anyShareWith(v.shareKeys, 'export'))) return;
    throw AppError.forbidden('Exporting needs the “Export” permission (Editors and Admins have it)');
  }

  /** Yields the CSV in chunks; `onDone` gets the row count (audit log, metrics). */
  async *assetsCsv(p: Principal, query: AssetExportQuery, onDone: (rows: number) => void): AsyncGenerator<string> {
    const visibility = await this.access.visibility(p, 'export');
    const typeIds = await this.store.assetTypeIdsIn({ ...query, limit: 1, offset: 0 }, visibility);
    const types = (await Promise.all(typeIds.map((id) => this.store.getType(id)))).filter((t): t is AssetType => !!t).sort((a, b) => a.name.localeCompare(b.name));
    const columns = this.columns(types, scopesFor(p, 'restricted').length > 0);
    yield CSV_BOM + csvLine(columns.map((c) => c.header));

    let rows = 0;
    const units = new Map<string, string>();
    const catalogs = new Map<string, string | undefined>();
    for (let offset = 0; offset < EXPORT_ROW_LIMIT; offset += PAGE) {
      const page = await this.assets.list(p, { ...query, limit: Math.min(PAGE, EXPORT_ROW_LIMIT - offset), offset }, 'export');
      if (!page.items.length) break;
      const names = await this.names(page.items, types, units, catalogs);
      let chunk = '';
      for (const a of page.items) chunk += csvLine(columns.map((c) => c.value(a, names)));
      rows += page.items.length;
      yield chunk;
      if (offset + PAGE >= page.total) break;
    }
    onDone(rows);
  }

  private columns(types: AssetType[], canSeeRestricted: boolean): Column[] {
    const typeById = new Map(types.map((t) => [t.id, t]));
    // One column per field key across the exported types ("Vendor" once, even if several templates have it).
    const fields = new Map<string, FieldDefinition>();
    for (const t of types) for (const f of t.fields) if (!fields.has(f.key) && (canSeeRestricted || !isRestricted(f))) fields.set(f.key, f);
    return [
      { header: 'Name', value: (a) => a.name },
      { header: 'Type', value: (a) => typeById.get(a.assetTypeId)?.name },
      { header: 'Status', value: (a) => typeById.get(a.assetTypeId)?.statuses.find((s) => s.value === a.status)?.label ?? a.status },
      { header: 'Team', value: (a, n) => n.unitPath(a.unitId) },
      { header: 'Catalog', value: (a, n) => (a.catalogId ? n.catalog(a.catalogId) : '') },
      { header: 'Owner', value: (a, n) => (a.ownerId ? n.person(a.ownerId) : '') },
      ...[...fields.values()].map(
        (f): Column => ({
          header: f.kind === 'currency' ? `${f.label} (${f.config.currency})` : f.label,
          value: (a, n) => {
            // The field of this asset's own type (same key may differ in kind across types).
            const own = typeById.get(a.assetTypeId)?.fields.find((x) => x.key === f.key);
            const v = a.attributes[f.key];
            if (!own || v === undefined || v === null) return '';
            // Numbers stay numbers so spreadsheets can sum and sort them.
            if (own.kind === 'currency' || own.kind === 'number') return v;
            return attributeText(own, v, { personName: n.person, assetName: n.asset }) ?? '';
          },
        }),
      ),
      { header: 'Created', value: (a) => a.createdAt },
      { header: 'Updated', value: (a) => a.updatedAt },
      { header: 'ID', value: (a) => a.id },
    ];
  }

  private async names(items: Asset[], types: AssetType[], unitCache: Map<string, string>, catalogCache: Map<string, string | undefined>): Promise<Names> {
    const typeById = new Map(types.map((t) => [t.id, t]));
    const people = new Set<string>();
    const refs = new Set<string>();
    for (const a of items) {
      if (a.ownerId) people.add(a.ownerId);
      for (const f of typeById.get(a.assetTypeId)?.fields ?? []) {
        const v = a.attributes[f.key];
        if (typeof v !== 'string') continue;
        if (f.kind === 'user') people.add(v);
        if (f.kind === 'assetRef') refs.add(v);
      }
    }
    const missingUnits = [...new Set(items.map((a) => a.unitId))].filter((id) => !unitCache.has(id));
    const paths = await this.store.unitPaths(missingUnits);
    const [personNames, assetNames, unitNames] = await Promise.all([this.store.userNames([...people]), this.store.assetNames([...refs]), this.store.unitNames([...paths.values()].flat())]);
    for (const [id, path] of paths) unitCache.set(id, path.map((x) => unitNames.get(x) ?? '').filter(Boolean).join(' › '));
    for (const id of new Set(items.map((a) => a.catalogId))) {
      if (id && !catalogCache.has(id)) catalogCache.set(id, (await this.store.getCatalog(id))?.name);
    }
    return {
      person: (id) => personNames.get(id),
      asset: (id) => assetNames.get(id),
      unitPath: (id) => unitCache.get(id) ?? '',
      catalog: (id) => catalogCache.get(id),
    };
  }
}
