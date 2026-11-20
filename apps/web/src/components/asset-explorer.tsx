import type { Asset, AssetType, FieldDefinition, SavedQuery, SavedView, TypeVariant } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Bookmark, Columns3, Search, Shapes, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError, withQuery } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { keys, useAssets, useLookups, usePeople } from '@/lib/queries';
import { formatDateTime } from '@/lib/utils';
import { AttributeValue } from './attribute';
import { StatusBadge } from './badges';
import { FilterBar } from './filter-builder';
import { Highlight } from './highlight';
import { PersonName, UnitPath, UnitPicker, AssetTypeSelect } from './pickers';
import { TypeIcon } from './type-icon';
import { Button } from './ui/button';
import { BulkActions } from './bulk-actions';
import { DataTable, ExportButton, exportRows, type DataColumn, type SortState } from './ui/data-table';
import { downloadUrl } from '@/lib/download';
import { EmptyState } from './ui/display';
import { Checkbox, Field, Input, Select } from './ui/form';
import { Dialog, Popover } from './ui/overlay';

const PAGE = 50;
/** Above this, act on a narrower search instead (and the export covers any size). */
const SELECT_ALL_MAX = 2000;

/**
 * In a table the name, type, status and team already have columns, so show the
 * segments of the snippet that actually contain a match ("Vendor: «Datadog»").
 */
function matchedPart(snippet: string): string {
  const parts = snippet.split(' · ').filter((p) => p.includes('«'));
  return parts.length ? parts.slice(0, 3).join(' · ') : snippet;
}

/**
 * Columns come from the type's fields, so every template gets a tailored table.
 * `visible` (column ids, in order) is the person's own choice; without it the
 * template's "Show as table column" fields are shown.
 */
function columnsFor(type: AssetType | undefined, variant: TypeVariant | undefined, lookups: ReturnType<typeof useLookups>, searching: boolean, visible?: string[]) {
  const all = allColumnsFor(type, variant, lookups, searching);
  const fields = [...(type?.fields ?? []), ...(variant?.fields ?? [])];
  const defaults = all.filter((c) => !c.id!.startsWith('attributes.') || fields.filter((f) => f.showInTable).slice(0, 6).some((f) => `attributes.${f.key}` === c.id)).map((c) => c.id!);
  const chosen = visible?.length ? ['name', ...visible.filter((id) => id !== 'name')].filter((id) => all.some((c) => c.id === id)) : defaults;
  return { all, defaults, columns: chosen.map((id) => all.find((c) => c.id === id)!) };
}

function allColumnsFor(type: AssetType | undefined, variant: TypeVariant | undefined, lookups: ReturnType<typeof useLookups>, searching: boolean): Array<DataColumn<Asset>> {
  // With a variant chosen, its own fields become columns too.
  const fieldCols = [...(type?.fields ?? []), ...(variant?.fields ?? [])]
    .map((f: FieldDefinition) => ({
      id: `attributes.${f.key}`,
      header: f.label,
      meta: { sortKey: `attributes.${f.key}`, align: f.kind === 'currency' || f.kind === 'number' ? ('right' as const) : undefined, csvValue: (a: Asset) => csvText(a.attributes[f.key]) },
      cell: ({ row }: { row: { original: Asset } }) => <AttributeValue field={f} value={row.original.attributes[f.key]} compact />,
    }));
  return [
    {
      id: 'name',
      header: 'Name',
      meta: { sortKey: 'name', csvValue: (a: Asset) => `${a.name} (${a.reference})` },
      cell: ({ row }) => {
        const t = lookups.typeById.get(row.original.assetTypeId);
        return (
          <span className="flex min-w-0 items-start gap-2.5">
            {!type && t && <TypeIcon icon={t.icon} color={t.color} size={22} />}
            <span className="min-w-0">
              <span className="flex max-w-80 items-baseline gap-1.5">
                <span className="truncate font-medium">{row.original.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-subtle">{row.original.reference}</span>
              </span>
              {searching && row.original.snippet && <Highlight snippet={matchedPart(row.original.snippet)} className="block max-w-[32rem] truncate text-xs text-muted" />}
            </span>
          </span>
        );
      },
    },
    ...(type
      ? []
      : [{ id: 'type', header: 'Type', meta: { sortKey: 'type', csvValue: (a: Asset) => lookups.schemaOf(a.assetTypeId, a.variantId)?.name }, cell: ({ row }: { row: { original: Asset } }) => <span className="text-muted">{lookups.schemaOf(row.original.assetTypeId, row.original.variantId)?.name}</span> }]),
    ...(type && !variant && lookups.variants.some((v) => v.assetTypeId === type.id)
      ? [{ id: 'kind', header: 'Kind', cell: ({ row }: { row: { original: Asset } }) => <span className="text-muted">{row.original.variantId ? lookups.variantById.get(row.original.variantId)?.name : 'Standard'}</span> }]
      : []),
    { id: 'status', header: 'Status', meta: { sortKey: 'status', csvValue: (a: Asset) => lookups.typeById.get(a.assetTypeId)?.statuses.find((x) => x.value === a.status)?.label ?? a.status }, cell: ({ row }) => <StatusBadge type={lookups.typeById.get(row.original.assetTypeId)} status={row.original.status} /> },
    ...fieldCols,
    { id: 'unit', header: 'Team', meta: { sortKey: 'unit', csvValue: (a: Asset) => (lookups.unitById.get(a.unitId)?.path ?? []).map((id) => lookups.unitById.get(id)?.name).join(' > ') }, cell: ({ row }) => <UnitPath id={row.original.unitId} className="max-w-56" /> },
    { id: 'owner', header: 'Owner', meta: { sortKey: 'owner' }, cell: ({ row }) => <PersonName id={row.original.ownerId} /> },
    { id: 'updated', header: 'Updated', meta: { sortKey: 'updatedAt', csvValue: (a: Asset) => a.updatedAt }, cell: ({ row }) => <span className="text-muted">{formatDateTime(row.original.updatedAt)}</span> },
  ];
}

/** A field value as spreadsheet text. */
function csvText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(csvText).join('; ');
  if (typeof v === 'object') return 'amount' in (v as object) ? `${(v as { amount: unknown }).amount} ${(v as { currency?: string }).currency ?? ''}`.trim() : JSON.stringify(v);
  return String(v);
}

export interface ExplorerQuery extends Required<Pick<SavedQuery, 'filters'>> {
  assetTypeId?: string;
  variantId?: string;
  unitId?: string;
  includeSubunits: boolean;
  status?: string;
  q: string;
  sort?: SortState;
  columns?: string[];
}

const fromSaved = (s: SavedQuery = {}): ExplorerQuery => ({
  assetTypeId: s.assetTypeId,
  variantId: s.variantId,
  unitId: s.unitId,
  includeSubunits: s.includeSubunits ?? true,
  status: s.status,
  q: s.q ?? '',
  filters: s.filters ?? [],
  sort: s.sort ? { sort: s.sort, order: s.order ?? 'desc' } : undefined,
  columns: s.columns,
});

const toSaved = (q: ExplorerQuery): SavedQuery => ({
  ...(q.assetTypeId && { assetTypeId: q.assetTypeId }),
  ...(q.variantId && { variantId: q.variantId }),
  ...(q.unitId && { unitId: q.unitId, includeSubunits: q.includeSubunits }),
  ...(q.status && { status: q.status }),
  ...(q.q && { q: q.q }),
  ...(q.filters.length && { filters: q.filters }),
  ...(q.sort && { sort: q.sort.sort, order: q.sort.order }),
  ...(q.columns && { columns: q.columns }),
});

/** Column choices outside a saved view: remembered in this browser, per asset type. */
const layoutKey = (typeId?: string) => `asset-columns:${typeId ?? 'all'}`;
function rememberedColumns(typeId?: string): string[] | undefined {
  try {
    return JSON.parse(localStorage.getItem(layoutKey(typeId)) ?? 'null') ?? undefined;
  } catch {
    return undefined;
  }
}
function rememberColumns(typeId: string | undefined, columns: string[] | undefined) {
  try {
    if (columns) localStorage.setItem(layoutKey(typeId), JSON.stringify(columns));
    else localStorage.removeItem(layoutKey(typeId));
  } catch {
    /* private mode */
  }
}

/**
 * Search + filters + table for assets: used by "All assets", each asset type,
 * a team's page and saved views. `fixed` pins parts of the query (e.g. the
 * team on a team page); everything else is the user's to change and save.
 */
export function AssetExplorer({
  initial,
  fixed = {},
  view,
  empty,
  title,
}: {
  initial?: SavedQuery;
  fixed?: { assetTypeId?: string; unitId?: string; catalogId?: string; importBatchId?: string };
  view?: SavedView;
  empty?: React.ReactNode;
  /** Names the CSV export ("Software licenses 2026-11-19.csv"). */
  title?: string;
}) {
  const lookups = useLookups();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [query, setQuery] = useState<ExplorerQuery>(() => ({ ...fromSaved(initial), ...fixed }));
  const [offset, setOffset] = useState(0);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  // Selected items, kept across pages (by id, with the item as last seen).
  const [picked, setPicked] = useState<Map<string, Asset>>(new Map());
  const [, setLayoutTick] = useState(0);
  const [selectingAll, setSelectingAll] = useState(false);
  // Everyone a selected item points at (owner and person fields), for the export.
  const people = usePeople([...picked.values()].flatMap((a) => [a.ownerId, ...Object.values(a.attributes).filter((v): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v))]));
  const search = useDebounced(query.q);
  const key = JSON.stringify({ initial, fixed });

  useEffect(() => {
    setQuery({ ...fromSaved(initial), ...fixed });
    setOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = (patch: Partial<ExplorerQuery>) => {
    setQuery((q) => ({ ...q, ...patch }));
    setOffset(0);
  };

  const type = query.assetTypeId ? lookups.typeById.get(query.assetTypeId) : undefined;
  const sort: SortState = query.sort ?? (search ? { sort: 'relevance', order: 'desc' } : { sort: 'updatedAt', order: 'desc' });
  const listQuery = {
    assetTypeId: query.assetTypeId,
    unitId: query.unitId,
    includeSubunits: query.includeSubunits,
    catalogId: fixed.catalogId,
    importBatchId: fixed.importBatchId,
    variantId: query.variantId,
    status: query.status,
    q: search || undefined,
    filters: query.filters,
    sort: sort.sort,
    order: sort.order,
  };
  const assets = useAssets({ ...listQuery, limit: PAGE, offset });
  const exportTitle = view?.name ?? title ?? type?.name ?? 'Assets';
  const variant = query.variantId ? lookups.variantById.get(query.variantId) : undefined;
  const typeVariants = type ? lookups.variants.filter((v) => v.assetTypeId === type.id && !v.archived) : [];
  const chosenColumns = query.columns ?? (view ? undefined : rememberedColumns(query.assetTypeId));
  const layout = useMemo(() => columnsFor(type, variant, lookups, !!search, chosenColumns), [type, variant, lookups, search, JSON.stringify(chosenColumns)]);
  const columns = layout.columns;
  const setColumns = (ids: string[] | undefined) => {
    if (!view) rememberColumns(query.assetTypeId, ids);
    setQuery((q) => ({ ...q, columns: view ? ids : undefined }));
    if (!view) setLayoutTick((n) => n + 1);
  };
  const dirty = JSON.stringify(toSaved(query)) !== JSON.stringify(toSaved({ ...fromSaved(view?.query ?? initial), ...fixed }));
  const hasQuery = !!(query.q || query.filters.length || query.status || (query.unitId && !fixed.unitId) || (query.assetTypeId && !fixed.assetTypeId));

  const saveView = useMutation({
    mutationFn: (asNew: boolean) =>
      asNew || !view
        ? api.post<SavedView>('/api/registry/views', { name, query: toSaved({ ...query, columns: chosenColumns }), pinned: true })
        : api.put<SavedView>(`/api/registry/views/${view.id}`, { name: view.name, query: toSaved(query), pinned: view.pinned }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: keys.views });
      setSaving(false);
      toast.success(`Saved “${v.name}”`, { description: 'Find it in the sidebar under Saved views.' });
      if (!view || v.id !== view.id) void navigate({ to: '/views/$viewId', params: { viewId: v.id } });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the view'),
  });

  const error = assets.error instanceof ApiError ? assets.error.message : null;
  /** Every item matching the search and filters, not just this page. */
  const selectAll = async () => {
    setSelectingAll(true);
    try {
      const all = new Map(picked);
      for (let off = 0; off < (assets.data?.total ?? 0); off += 500) {
        const page = await api.get<{ items: Asset[] }>('/api/registry/assets', { ...listQuery, limit: 500, offset: off });
        page.items.forEach((a) => all.set(a.id, a));
      }
      setPicked(all);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not select everything');
    } finally {
      setSelectingAll(false);
    }
  };
  const pageItems = assets.data?.items ?? [];
  const selection = {
    selected: new Set(picked.keys()),
    onChange: (ids: Set<string>) =>
      setPicked((prev) => {
        const next = new Map<string, Asset>();
        for (const id of ids) {
          const a = prev.get(id) ?? pageItems.find((x) => x.id === id);
          if (a) next.set(id, a);
        }
        return next;
      }),
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 sm:px-6 py-3">
        <div className="relative w-full max-w-md min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" />
          <Input className="h-9 pl-8 text-[14px]" placeholder="Search anything — name, vendor, serial, person, team…" value={query.q} onChange={(e) => update({ q: e.target.value, sort: undefined })} />
          {query.q && (
            <button type="button" aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 text-subtle hover:text-fg" onClick={() => update({ q: '' })}>
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {!fixed.assetTypeId && (
          <div className="w-44">
            <AssetTypeSelect includeAll value={query.assetTypeId ?? null} onChange={(v) => update({ assetTypeId: v ?? undefined, variantId: undefined, status: undefined, filters: query.filters.filter((f) => !f.field.startsWith('attributes.')) })} />
          </div>
        )}
        {!fixed.unitId && (
          <div className="w-60">
            <UnitPicker allowClear clearLabel="All teams" value={query.unitId ?? null} onChange={(v) => update({ unitId: v ?? undefined })} />
          </div>
        )}
        {query.unitId && <Checkbox checked={query.includeSubunits} onChange={(includeSubunits) => update({ includeSubunits })} label={<span className="text-xs text-muted">Include sub-teams</span>} />}
        {typeVariants.length > 0 && (
          <Select className="w-44" value={query.variantId ?? ''} onChange={(e) => update({ variantId: e.target.value || undefined, filters: query.filters.filter((f) => !f.field.startsWith('attributes.') || type!.fields.some((x) => `attributes.${x.key}` === f.field)) })} aria-label="Kind">
            <option value="">Every kind</option>
            {typeVariants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        )}
        {type && (
          <Select className="w-36" value={query.status ?? ''} onChange={(e) => update({ status: e.target.value || undefined })}>
            <option value="">Any status</option>
            {type.statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        )}
        <FilterBar type={type && variant ? { ...type, fields: [...type.fields, ...variant.fields] } : type} value={query.filters} onChange={(filters) => update({ filters })} />
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs text-subtle">{assets.data ? `${assets.data.total.toLocaleString()} ${assets.data.total === 1 ? 'result' : 'results'}` : ''}</span>
          <ColumnsMenu all={layout.all} shown={columns.map((c) => c.id!)} defaults={layout.defaults} onChange={setColumns} />
          <ExportButton disabled={!assets.data?.total} onExport={() => downloadUrl(withQuery('/api/registry/assets/export.csv', { ...listQuery, title: exportTitle }))} />
          {(hasQuery || view) && (view ? dirty : true) && (
            <Button icon={<Bookmark className="size-3.5" />} onClick={() => (view ? saveView.mutate(false) : (setName(''), setSaving(true)))} loading={saveView.isPending}>
              {view ? 'Save changes' : 'Save view'}
            </Button>
          )}
          {view && (
            <Button variant="ghost" onClick={() => (setName(`${view.name} (copy)`), setSaving(true))}>
              Save as new
            </Button>
          )}
        </span>
      </div>
      {error && <p className="mx-6 mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      <DataTable
        columns={columns}
        data={assets.data?.items ?? []}
        loading={assets.isLoading}
        rowKey={(a) => a.id}
        selection={selection}
        onRowClick={(a) => void navigate({ to: '/assets/$assetId', params: { assetId: a.id } })}
        sort={sort}
        onSortChange={(s) => update({ sort: s })}
        page={assets.data ? { offset, limit: PAGE, total: assets.data.total, onChange: setOffset } : undefined}
        empty={
          hasQuery ? (
            <EmptyState icon={<Search />} title="Nothing matches" description="Try fewer words, a different spelling, or remove a filter." action={<Button onClick={() => update({ q: '', filters: [], status: undefined })}>Clear search</Button>} />
          ) : (
            (empty ?? <EmptyState icon={<Shapes />} title="No assets yet" />)
          )
        }
      />
      {/* Room for the action bar, so it never covers the last rows. */}
      {picked.size > 0 && <div className="h-20 shrink-0" />}
      {picked.size > 0 && <BulkActions
        items={[...picked.values()]}
        onClear={() => setPicked(new Map())}
        extra={
          assets.data && assets.data.total > picked.size && pageItems.every((a) => picked.has(a.id)) && assets.data.total <= SELECT_ALL_MAX ? (
            <Button size="sm" variant="ghost" loading={selectingAll} onClick={() => void selectAll()}>
              Select all {assets.data.total.toLocaleString()}
            </Button>
          ) : null
        } onExport={() =>
            exportRows(
              `${exportTitle} (selected)`,
              // People are stored by id: export their names.
              columns.map((c) => (c.id === 'owner' ? { ...c, meta: { ...c.meta, csvValue: (a: Asset) => a.ownerId } } : c)).map((c) => (c.meta?.csvValue ? { ...c, meta: { ...c.meta, csvValue: (a: Asset) => { const v = c.meta!.csvValue!(a); return typeof v === 'string' && people.has(v) ? people.get(v)!.displayName : v; } } } : c)),
              [...picked.values()],
            )
          } />}
      <Dialog
        open={saving}
        onOpenChange={setSaving}
        title="Save this view"
        description="Keeps the search, filters and sorting so you can come back with one click."
        footer={
          <>
            <Button onClick={() => setSaving(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} loading={saveView.isPending} onClick={() => saveView.mutate(true)}>
              Save view
            </Button>
          </>
        }
      >
        <Field label="Name">{(id) => <Input id={id} autoFocus value={name} placeholder="e.g. R&D licenses renewing this quarter" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && saveView.mutate(true)} />}</Field>
      </Dialog>
    </>
  );
}

/** Which columns the table shows, and in what order. */
function ColumnsMenu({ all, shown, defaults, onChange }: { all: Array<DataColumn<Asset>>; shown: string[]; defaults: string[]; onChange: (ids: string[] | undefined) => void }) {
  const label = (c: DataColumn<Asset>) => (typeof c.header === 'string' ? c.header : c.id!);
  const move = (id: string, d: -1 | 1) => {
    const next = [...shown];
    const i = next.indexOf(id);
    if (i + d < 1 || i + d >= next.length) return;
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  const custom = JSON.stringify(shown) !== JSON.stringify(defaults);
  return (
    <Popover
      align="end"
      className="max-h-[var(--radix-popover-content-available-height)] w-64 overflow-y-auto p-2"
      trigger={
        <Button variant="ghost" icon={<Columns3 className="size-3.5" />}>
          Columns
        </Button>
      }
    >
      <p className="px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">Shown</p>
      <ul>
        {shown.map((id, i) => {
          const c = all.find((x) => x.id === id);
          if (!c) return null;
          return (
            <li key={id} className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-surface-2">
              <span className="flex-1">
                <Checkbox checked disabled={id === 'name'} onChange={() => onChange(shown.filter((x) => x !== id))} label={label(c)} />
              </span>
              {id !== 'name' && (
                <>
                  <Button size="icon" variant="ghost" className="size-6" aria-label={`Move ${label(c)} left`} disabled={i <= 1} icon={<ArrowUp className="size-3" />} onClick={() => move(id, -1)} />
                  <Button size="icon" variant="ghost" className="size-6" aria-label={`Move ${label(c)} right`} disabled={i === shown.length - 1} icon={<ArrowDown className="size-3" />} onClick={() => move(id, 1)} />
                </>
              )}
            </li>
          );
        })}
      </ul>
      {all.some((c) => !shown.includes(c.id!)) && (
        <>
          <p className="px-1 pt-3 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">Hidden</p>
          <ul>
            {all
              .filter((c) => !shown.includes(c.id!))
              .map((c) => (
                <li key={c.id} className="rounded-md px-1 py-1 hover:bg-surface-2">
                  <Checkbox checked={false} onChange={() => onChange([...shown, c.id!])} label={<span className="text-muted">{label(c)}</span>} />
                </li>
              ))}
          </ul>
        </>
      )}
      {custom && (
        <div className="mt-2 border-t border-border px-1 pt-2">
          <button type="button" className="text-xs text-accent-fg" onClick={() => onChange(undefined)}>
            Reset to the template’s columns
          </button>
        </div>
      )}
    </Popover>
  );
}
