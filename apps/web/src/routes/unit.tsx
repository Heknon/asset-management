import { addDuration, type Catalog, type OrgUnit, type UnitPerson, type UnitRollup, type UnitRole } from '@am/core';
import { GrantsEditor } from '@/components/access-grants';
import { CatalogCard, CatalogFormDialog } from '@/components/catalogs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Building2, ChevronRight, Inbox, Plus, Trash2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AssetExplorer } from '@/components/asset-explorer';
import { RequestStatusBadge } from '@/components/badges';
import { ObligationList } from '@/components/obligations';
import { PersonPicker } from '@/components/pickers';
import { useNewRequest } from '@/components/request-form';
import { Button } from '@/components/ui/button';
import { DataTable, ExportButton, exportRows, type DataColumn } from '@/components/ui/data-table';
import { Avatar, Badge, Card, EmptyState, IconTile, PageHeader, Spinner, Stat, Tabs } from '@/components/ui/display';
import { Select } from '@/components/ui/form';
import { api, ApiError } from '@/lib/api';
import { useMyOrg } from '@/lib/org';
import { keys, useAssets, useCatalogs, useLookups, useObligations, useRequests, useRollup, useSummary, useUnitPeople } from '@/lib/queries';
import { formatMoney, relativeDays, todayIso } from '@/lib/utils';

const money = (list: Array<{ currency: string; amount: number }> | undefined) => (list?.length ? list.map((s) => formatMoney(s.amount, s.currency, true)).join(' + ') : '—');

export function UnitPage() {
  const { unitId } = useParams({ strict: false }) as { unitId: string };
  const { unitById, childrenOf, ready } = useLookups();
  const { me, can, mine } = useMyOrg();
  const unit = unitById.get(unitId);
  const [tab, setTab] = useState('overview');
  const summary = useSummary({ unitId });
  const assets = useAssets({ unitId, limit: 1 });
  const openRequests = useRequests({ scope: 'all', unitId, status: 'open', limit: 50 });
  const people = useUnitPeople(unitId);
  const newRequest = useNewRequest();

  if (!ready) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!unit) return <EmptyState title="Team not found" />;

  const spend = summary.data?.spend.map((s) => ({ currency: s.currency, amount: s.next365 }));
  const managers = (people.data ?? []).filter((p) => p.role === 'manager');
  const myRole = mine.find((m) => m.unit.id === unit.id)?.role;
  const catalogs = useCatalogs({ unitId: unit.id });
  const canManagePeople = !!me?.isAdmin || mine.some((m) => m.role === 'manager' && unit.path.includes(m.unit.id));

  return (
    <>
      <PageHeader
        icon={
          <IconTile color={unit.color} size={40}>
            <Building2 />
          </IconTile>
        }
        title={unit.name}
        description={
          <span className="flex flex-wrap items-center gap-1">
            {unit.path.slice(0, -1).map((id) => (
              <span key={id} className="inline-flex items-center gap-1">
                <Link to="/units/$unitId" params={{ unitId: id }} className="hover:text-fg hover:underline">
                  {unitById.get(id)?.name}
                </Link>
                <ChevronRight className="size-3 text-subtle" />
              </span>
            ))}
            <Badge>{unit.kind}</Badge>
            {myRole && <Badge tone="accent">{myRole === 'manager' ? 'You manage this' : 'Your team'}</Badge>}
          </span>
        }
        actions={
          <>
            {managers.length > 0 && (
              <span className="mr-2 flex -space-x-1.5" title={`Managed by ${managers.map((m) => m.displayName).join(', ')}`}>
                {managers.slice(0, 4).map((m) => (
                  <Avatar key={m.id} name={m.displayName} size={26} className="ring-2 ring-bg" />
                ))}
              </span>
            )}
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={newRequest}>
              Request something
            </Button>
          </>
        }
      >
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'assets', label: 'Assets', count: assets.data?.total },
            { value: 'requests', label: 'Requests', count: openRequests.data?.total },
            { value: 'catalogs', label: 'Catalogs', count: catalogs.data?.length },
            { value: 'access', label: 'Access' },
            { value: 'people', label: 'People', count: people.data ? new Set(people.data.map((p) => p.id)).size : undefined },
          ]}
        />
      </PageHeader>

      {tab === 'overview' && (
        <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Assets" value={assets.data?.total.toLocaleString() ?? '–'} hint="Including sub-teams" />
            <Stat label="Renewing in 12 months" value={money(spend)} hint="Recurring spend" />
            <Stat label="Overdue" value={summary.data?.overdue ?? '–'} tone={summary.data?.overdue ? 'danger' : undefined} />
            <Stat label="Open requests" value={openRequests.data?.total ?? '–'} />
          </div>
          <SubUnits unitId={unit.id} childIds={childrenOf(unit.id).filter((c) => !c.archived).map((c) => c.id)} />
          <UpcomingFor unitId={unit.id} canEdit={(o) => can(o.unitId, 'renew', o.assetTypeId)} />
          {(openRequests.data?.items.length ?? 0) > 0 && <RequestList items={openRequests.data!.items.slice(0, 8)} title="Open requests" />}
        </div>
      )}
      {tab === 'assets' && <AssetExplorer fixed={{ unitId: unit.id }} initial={{ includeSubunits: true }} />}
      {tab === 'requests' && (
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <RequestList items={openRequests.data?.items ?? []} title="Open requests" empty="No open requests for this team." />
        </div>
      )}
      {tab === 'access' && (
        <div className="mx-auto w-full max-w-3xl space-y-3 px-6 py-6">
          <p className="text-[13px] text-muted">Who can see and work with {unit.name}’s items — and everything in the units beneath it. Give access to people, other units or directory groups.</p>
          <GrantsEditor unitId={unit.id} />
        </div>
      )}
      {tab === 'catalogs' && <CatalogsTab unitId={unit.id} catalogs={catalogs.data ?? []} />}
      {tab === 'people' && <PeopleTab unitId={unit.id} people={people.data ?? []} editable={canManagePeople} />}
    </>
  );
}

/** Catalogs owned by this unit and its sub-units, plus creating one (managers). */
function CatalogsTab({ unitId, catalogs }: { unitId: string; catalogs: Catalog[] }) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const canCreate = useMyOrg().unitPermissionsOn(unitId).has('manage');
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted">Collections of this unit’s assets that it can share with other teams, divisions or people.</p>
        {canCreate && (
          <Button icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
            New catalog
          </Button>
        )}
      </div>
      {catalogs.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {catalogs.map((c) => (
            <CatalogCard key={c.id} catalog={c} />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState title="No catalogs" description={canCreate ? 'Group assets — licenses, lab equipment, tools — into a catalog to share them with the teams that use them.' : 'Its managers can create catalogs to share assets with other teams.'} />
        </Card>
      )}
      <CatalogFormDialog open={creating} onOpenChange={setCreating} unitId={unitId} onSaved={(c) => void navigate({ to: '/catalogs/$catalogId', params: { catalogId: c.id } })} />
    </div>
  );
}

function SubUnits({ unitId, childIds }: { unitId: string; childIds: string[] }) {
  const rollup = useRollup(unitId);
  const { unitById } = useLookups();
  const navigate = useNavigate();
  const rows = useMemo(() => {
    const byId = new Map((rollup.data ?? []).map((r) => [r.unitId, r]));
    return childIds.flatMap((id) => {
      const unit = unitById.get(id);
      return unit ? [{ unit, r: byId.get(id) }] : [];
    });
  }, [childIds, unitById, rollup.data]);
  if (!childIds.length) return null;
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-1.5">
        <span className="text-[13px] font-semibold">Sub-units</span>
        <ExportButton onExport={() => exportRows(`${unitById.get(unitId)?.name ?? 'Unit'} sub-units`, SUB_UNIT_COLUMNS, rows)} />
      </div>
      <DataTable
        columns={SUB_UNIT_COLUMNS}
        data={rows}
        sort={{ sort: 'name', order: 'asc' }}
        rowKey={(row) => row.unit.id}
        onRowClick={(row) => void navigate({ to: '/units/$unitId', params: { unitId: row.unit.id } })}
      />
    </Card>
  );
}

type SubUnitRow = { unit: OrgUnit; r?: UnitRollup };
/** Orders by face value; mixed currencies are not converted (the cell shows each one). */
const spendTotal = (r?: UnitRollup) => r?.spendNext365.reduce((n, s) => n + s.amount, 0) ?? 0;
const SUB_UNIT_COLUMNS: Array<DataColumn<SubUnitRow>> = [
  {
    id: 'name',
    header: 'Unit',
    meta: { sortKey: 'name', sortValue: (row) => row.unit.name },
    cell: ({ row: { original: { unit } } }) => (
      <span className="flex items-center gap-2 font-medium">
        <span className="size-2 rounded-full" style={{ background: unit.color }} />
        {unit.name}
        <span className="text-xs font-normal text-subtle">{unit.kind}</span>
      </span>
    ),
  },
  { id: 'open', header: 'Open items', meta: { sortKey: 'open', align: 'right', sortValue: (row) => row.r?.openItems ?? 0 }, cell: ({ row }) => row.original.r?.openItems ?? 0 },
  {
    id: 'overdue',
    header: 'Overdue',
    meta: { sortKey: 'overdue', align: 'right', sortValue: (row) => row.r?.overdue ?? 0 },
    cell: ({ row }) => (row.original.r?.overdue ? <span className="font-medium text-danger">{row.original.r.overdue}</span> : 0),
  },
  { id: 'renewing', header: 'Renewing ≤ 90 days', meta: { sortKey: 'renewing', align: 'right', sortValue: (row) => row.r?.renewingNext90 ?? 0 }, cell: ({ row }) => row.original.r?.renewingNext90 ?? 0 },
  { id: 'spend', header: 'Next 12 months', meta: { sortKey: 'spend', align: 'right', sortValue: (row) => spendTotal(row.r), csvValue: (row) => money(row.r?.spendNext365) }, cell: ({ row }) => money(row.original.r?.spendNext365) },
];

function UpcomingFor({ unitId, canEdit }: { unitId: string; canEdit: Parameters<typeof ObligationList>[0]['canEdit'] }) {
  const today = todayIso();
  const items = useObligations({ unitId, state: 'active', to: addDuration(today, { amount: 120, unit: 'day' }), limit: 15 });
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-[13px] font-semibold">Coming up in the next 4 months</span>
        <Link to="/" className="text-xs text-accent-fg hover:underline">
          All upcoming
        </Link>
      </div>
      {items.data?.items.length ? <ObligationList items={items.data.items} canEdit={canEdit} /> : <p className="px-4 py-6 text-center text-xs text-muted">{items.isLoading ? 'Loading…' : 'Nothing due soon.'}</p>}
    </Card>
  );
}

export function RequestList({ items, title, empty }: { items: import('@am/core').PurchaseRequest[]; title: string; empty?: string }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="border-b border-border px-4 py-2.5 text-[13px] font-semibold">{title}</div>
      {items.length ? (
        <ul className="divide-y divide-border">
          {items.map((r) => (
            <li key={r.id}>
              <Link to="/requests/$requestId" params={{ requestId: r.id }} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2/50">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{r.title}</span>
                  <span className="text-xs text-muted">
                    {r.number} · {r.requesterName} · {relativeDays(r.createdAt.slice(0, 10))}
                  </span>
                </span>
                <RequestStatusBadge status={r.status} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Inbox />} title={empty ?? 'Nothing here'} />
      )}
    </Card>
  );
}

/** Members and managers. Directory-synced people are read-only here; managers can add people by hand. */
function PeopleTab({ unitId, people, editable }: { unitId: string; people: UnitPerson[]; editable: boolean }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | null>(null);
  const [role, setRole] = useState<UnitRole>('member');
  const manual = people.filter((p) => p.source === 'manual');
  const save = useMutation({
    mutationFn: (next: UnitPerson[]) =>
      api.put(`/api/identity/units/${unitId}/people`, { members: next.filter((p) => p.role === 'member').map((p) => p.id), managers: next.filter((p) => p.role === 'manager').map((p) => p.id) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.unitPeople(unitId) });
      void qc.invalidateQueries({ queryKey: keys.units });
      toast.success('People updated', { description: 'Their access changes at their next sign-in or within 15 minutes.' });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update people'),
  });
  const groups: Array<{ role: UnitRole; title: string; hint: string }> = [
    { role: 'manager', title: 'Managers', hint: 'Manage everything in this unit and below it, and are told about its requests and orphaned renewals.' },
    { role: 'member', title: 'Members', hint: 'See this unit’s assets and can request things for it.' },
  ];
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-6">
      {editable && (
        <Card className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <p className="mb-1.5 text-xs font-medium text-muted">Add someone who isn’t in the directory group</p>
            <PersonPicker value={adding} onChange={setAdding} placeholder="Search people" />
          </div>
          <Select className="w-32" value={role} onChange={(e) => setRole(e.target.value as UnitRole)}>
            <option value="member">Member</option>
            <option value="manager">Manager</option>
          </Select>
          <Button
            variant="primary"
            disabled={!adding}
            loading={save.isPending}
            onClick={() => {
              if (!adding) return;
              save.mutate([...manual, { id: adding, role, source: 'manual', username: '', displayName: '', email: null }]);
              setAdding(null);
            }}
          >
            Add
          </Button>
        </Card>
      )}
      {groups.map((g) => {
        const list = people.filter((p) => p.role === g.role);
        return (
          <Card key={g.role} padded={false}>
            <div className="border-b border-border px-4 py-2.5">
              <p className="text-[13px] font-semibold">
                {g.title} <span className="font-normal text-subtle">{list.length}</span>
              </p>
              <p className="text-xs text-muted">{g.hint}</p>
            </div>
            {list.length ? (
              <ul className="divide-y divide-border">
                {list.map((p) => (
                  <li key={`${p.id}-${p.role}`} className="flex items-center gap-3 px-4 py-2.5">
                    <Avatar name={p.displayName} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{p.displayName}</span>
                      <span className="block truncate text-xs text-muted">{p.email ?? p.username}</span>
                    </span>
                    <Badge>{p.source === 'directory' ? 'From directory' : 'Added by hand'}</Badge>
                    {editable && p.source === 'manual' && (
                      <Button size="icon" variant="ghost" aria-label="Remove" icon={<Trash2 className="size-3.5" />} onClick={() => save.mutate(manual.filter((m) => !(m.id === p.id && m.role === p.role)))} />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Users />} title={`No ${g.title.toLowerCase()} yet`} />
            )}
          </Card>
        );
      })}
    </div>
  );
}
