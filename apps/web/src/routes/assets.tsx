import { atLeast, effectiveLevel, type Asset, type AssetType, type FieldDefinition } from '@am/core';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Search, Shapes } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AssetFormSheet } from '@/components/asset-form';
import { AttributeValue } from '@/components/attribute';
import { StatusBadge } from '@/components/badges';
import { PersonName, PurchaseClassSelect } from '@/components/pickers';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { DataTable, type SortState } from '@/components/ui/data-table';
import { Badge, EmptyState, PageHeader } from '@/components/ui/display';
import { Input, Select } from '@/components/ui/form';
import { useAssets, useLookups, useMe } from '@/lib/queries';
import { formatDateTime } from '@/lib/utils';

const PAGE = 50;

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Columns come from the type's fields, so every template gets a tailored table. */
function columnsFor(type: AssetType | undefined, lookups: ReturnType<typeof useLookups>): Array<ColumnDef<Asset, unknown> & { meta?: { sortKey?: string; align?: 'right' } }> {
  const fieldCols = (type?.fields ?? [])
    .filter((f) => f.showInTable)
    .slice(0, 6)
    .map((f: FieldDefinition) => ({
      id: f.key,
      header: f.label,
      meta: { sortKey: `attributes.${f.key}`, align: f.kind === 'currency' || f.kind === 'number' ? ('right' as const) : undefined },
      cell: ({ row }: { row: { original: Asset } }) => <AttributeValue field={f} value={row.original.attributes[f.key]} compact />,
    }));
  return [
    {
      id: 'name',
      header: 'Name',
      meta: { sortKey: 'name' },
      cell: ({ row }) => {
        const t = lookups.typeById.get(row.original.assetTypeId);
        return (
          <span className="flex items-center gap-2.5 font-medium">
            {!type && t && <TypeIcon icon={t.icon} color={t.color} size={22} />}
            <span className="max-w-72 truncate">{row.original.name}</span>
          </span>
        );
      },
    },
    ...(type ? [] : [{ id: 'type', header: 'Type', cell: ({ row }: { row: { original: Asset } }) => <span className="text-muted">{lookups.typeById.get(row.original.assetTypeId)?.name}</span> }]),
    { id: 'status', header: 'Status', meta: { sortKey: 'status' }, cell: ({ row }) => <StatusBadge type={lookups.typeById.get(row.original.assetTypeId)} status={row.original.status} /> },
    ...fieldCols,
    {
      id: 'class',
      header: 'Purchased for',
      cell: ({ row }) => {
        const c = lookups.classById.get(row.original.purchaseClassId);
        return c ? <Badge color={c.color}>{c.name}</Badge> : null;
      },
    },
    { id: 'owner', header: 'Owner', cell: ({ row }) => <PersonName id={row.original.ownerId} /> },
    { id: 'updated', header: 'Updated', meta: { sortKey: 'updatedAt' }, cell: ({ row }) => <span className="text-muted">{formatDateTime(row.original.updatedAt)}</span> },
  ];
}

export function AssetsPage() {
  const { type: typeId } = useSearch({ strict: false }) as { type?: string };
  const lookups = useLookups();
  const me = useMe().data!;
  const navigate = useNavigate();
  const type = typeId ? lookups.typeById.get(typeId) : undefined;
  const [q, setQ] = useState('');
  const [classId, setClassId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState<SortState>({ sort: 'updatedAt', order: 'desc' });
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const search = useDebounced(q);

  useEffect(() => {
    setOffset(0);
    setStatus('');
    setSort({ sort: 'updatedAt', order: 'desc' });
  }, [typeId]);

  const assets = useAssets({ assetTypeId: typeId, q: search || undefined, purchaseClassId: classId ?? undefined, status: status || undefined, sort: sort.sort, order: sort.order, limit: PAGE, offset });
  const columns = useMemo(() => columnsFor(type, lookups), [type, lookups]);
  const canCreate = !!type && !type.archived && (me.isAdmin || lookups.classes.some((c) => atLeast(effectiveLevel(me, { purchaseClassId: c.id, assetTypeId: type.id }), 'edit')));

  return (
    <>
      <PageHeader
        title={type?.name ?? 'All assets'}
        description={type?.description ?? 'Everything you have access to, across every type.'}
        icon={type ? <TypeIcon icon={type.icon} color={type.color} size={36} /> : undefined}
        actions={
          canCreate && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New {type!.name.toLowerCase()}
            </Button>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" />
            <Input className="pl-8" placeholder="Search name or fields…" value={q} onChange={(e) => (setQ(e.target.value), setOffset(0))} />
          </div>
          <div className="w-48">
            <PurchaseClassSelect includeAll value={classId} onChange={(v) => (setClassId(v), setOffset(0))} />
          </div>
          {type && (
            <Select className="w-36" value={status} onChange={(e) => (setStatus(e.target.value), setOffset(0))}>
              <option value="">Any status</option>
              {type.statuses.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
          <span className="ml-auto text-xs text-subtle">{assets.data ? `${assets.data.total} ${assets.data.total === 1 ? 'asset' : 'assets'}` : ''}</span>
        </div>
      </PageHeader>
      <DataTable
        columns={columns}
        data={assets.data?.items ?? []}
        loading={assets.isLoading}
        rowKey={(a) => a.id}
        onRowClick={(a) => void navigate({ to: '/assets/$assetId', params: { assetId: a.id } })}
        sort={sort}
        onSortChange={(s) => (setSort(s), setOffset(0))}
        page={assets.data ? { offset, limit: PAGE, total: assets.data.total, onChange: setOffset } : undefined}
        empty={
          <EmptyState
            icon={<Shapes />}
            title={q || classId || status ? 'No matching assets' : 'No assets yet'}
            description={q || classId || status ? 'Try a different search or filter.' : type ? `Create the first ${type.name.toLowerCase()} to start tracking it.` : 'Pick an asset type in the sidebar to add one.'}
            action={canCreate && !q ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New {type!.name.toLowerCase()}</Button> : undefined}
          />
        }
      />
      {type && <AssetFormSheet open={creating} onOpenChange={setCreating} type={type} />}
    </>
  );
}
