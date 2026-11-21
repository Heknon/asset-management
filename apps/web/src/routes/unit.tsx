import { addDuration, type Catalog, type OrgUnit, type UnitPerson, type UnitRollup, type UnitRole } from '@am/core';
import { GrantsEditor } from '@/components/access-grants';
import { TypeIcon } from '@/components/type-icon';
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
import { useRemember } from '@/lib/recent';
import { intlLocale, plural, t, tMaybe } from '@/lib/i18n';

const money = (list: Array<{ currency: string; amount: number }> | undefined) => (list?.length ? list.map((s) => formatMoney(s.amount, s.currency, true)).join(' + ') : '—');

export function UnitPage() {
  const { unitId } = useParams({ strict: false }) as { unitId: string };
  const { unitById, childrenOf, ready } = useLookups();
  const { me, can, mine } = useMyOrg();
  const unit = unitById.get(unitId);
  useRemember(unit ? { kind: 'unit', id: unit.id, title: unit.name, subtitle: tMaybe(unit.kind) } : null);
  const [tab, setTab] = useState('overview');
  const summary = useSummary({ unitId });
  const assets = useAssets({ unitId, limit: 1 });
  const openRequests = useRequests({ scope: 'all', unitId, status: 'open', limit: 50 });
  const people = useUnitPeople(unitId);
  const newRequest = useNewRequest();

  if (!ready) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!unit) return <EmptyState title={t('Team not found')} />;

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
            <Badge>{tMaybe(unit.kind)}</Badge>
            {myRole && <Badge tone="accent">{myRole === 'manager' ? t('You manage this') : t('Your team')}</Badge>}
          </span>
        }
        actions={
          <>
            {managers.length > 0 && (
              <span className="me-2 flex -space-x-1.5" title={t('Managed by {names}', { names: managers.map((m) => m.displayName).join(', ') })}>
                {managers.slice(0, 4).map((m) => (
                  <Avatar key={m.id} name={m.displayName} size={26} className="ring-2 ring-bg" />
                ))}
              </span>
            )}
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={newRequest}>
              {t('Request something')}
            </Button>
          </>
        }
      >
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'overview', label: t('Overview') },
            { value: 'assets', label: t('Assets'), count: assets.data?.total },
            { value: 'requests', label: t('Requests'), count: openRequests.data?.total },
            { value: 'catalogs', label: t('Catalogs'), count: catalogs.data?.length },
            { value: 'templates', label: t('Templates') },
            { value: 'access', label: t('Access') },
            { value: 'people', label: t('People'), count: people.data ? new Set(people.data.map((p) => p.id)).size : undefined },
          ]}
        />
      </PageHeader>

      {tab === 'overview' && (
        <div className="mx-auto w-full max-w-5xl space-y-6 px-4 sm:px-6 py-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('Assets')} value={assets.data?.total.toLocaleString(intlLocale()) ?? '–'} hint={t('Including sub-teams')} />
            <Stat label={t('Renewing in 12 months')} value={money(spend)} hint={t('Recurring spend')} />
            <Stat label={t('Overdue')} value={summary.data?.overdue ?? '–'} tone={summary.data?.overdue ? 'danger' : undefined} />
            <Stat label={t('Open requests')} value={openRequests.data?.total ?? '–'} />
          </div>
          <SubUnits unitId={unit.id} childIds={childrenOf(unit.id).filter((c) => !c.archived).map((c) => c.id)} />
          <UpcomingFor unitId={unit.id} canEdit={(o) => o.canHandle ?? can(o.unitId, 'renew', o.assetTypeId)} />
          {(openRequests.data?.items.length ?? 0) > 0 && <RequestList items={openRequests.data!.items.slice(0, 8)} title={t('Open requests')} />}
        </div>
      )}
      {tab === 'assets' && <AssetExplorer fixed={{ unitId: unit.id }} initial={{ includeSubunits: true }} />}
      {tab === 'requests' && (
        <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-6">
          <RequestList items={openRequests.data?.items ?? []} title={t('Open requests')} empty={t('No open requests for this team.')} />
        </div>
      )}
      {tab === 'templates' && <TemplatesTab unitId={unit.id} />}
      {tab === 'access' && (
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 sm:px-6 py-6">
          <p className="text-[13px] text-muted">{t('Who can see and work with {unit}’s items — and everything in the units beneath it. Give access to people, other units or directory groups.', { unit: unit.name })}</p>
          <GrantsEditor unitId={unit.id} />
        </div>
      )}
      {tab === 'catalogs' && <CatalogsTab unitId={unit.id} catalogs={catalogs.data ?? []} />}
      {tab === 'people' && <PeopleTab unitId={unit.id} people={people.data ?? []} editable={canManagePeople} />}
    </>
  );
}

/**
 * The organization's templates as this unit uses them: the variants it (or a
 * unit above it) defined, and "Extend for <unit>" to add its own fields.
 */
function TemplatesTab({ unitId }: { unitId: string }) {
  const { types, variantsFor, unitById } = useLookups();
  const { unitPermissionsOn, canManageOrganization } = useMyOrg();
  const canExtend = canManageOrganization || unitPermissionsOn(unitId).has('manage');
  const unit = unitById.get(unitId);
  return (
    <div className="mx-auto w-full max-w-4xl space-y-3 px-4 sm:px-6 py-6">
      <p className="text-[13px] text-muted">
        {t('Templates are shared by the whole organization. A unit can extend one with the fields it needs — a Lab’s “Design license” adds the workstation and MAC addresses — and everyone in {unit} and beneath it can use it.', { unit: unit?.name ?? '' })}
      </p>
      <Card padded={false} className="divide-y divide-border">
        {types
          .filter((type) => !type.archived)
          .map((type) => {
            const vs = variantsFor(type.id, unitId);
            return (
              <div key={type.id} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <TypeIcon icon={type.icon} color={type.color} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{type.name}</span>
                    <span className="block text-xs text-muted">
                      {vs.length
                        ? t('{fields} · {variants} here', { fields: plural(type.fields.length, '{n} field', '{n} fields'), variants: plural(vs.length, '{n} variant', '{n} variants') })
                        : plural(type.fields.length, '{n} field', '{n} fields')}
                    </span>
                  </span>
                  {canExtend && (
                    <Link to="/templates/$typeId/variants/$variantId" params={{ typeId: type.id, variantId: 'new' }} search={{ unit: unitId }}>
                      <Button size="sm" icon={<Plus className="size-3.5" />}>
                        {t('Extend for {unit}', { unit: unit?.name ?? '' })}
                      </Button>
                    </Link>
                  )}
                </div>
                {vs.length > 0 && (
                  <ul className="mt-2 ms-10 space-y-1">
                    {vs.map((v) => (
                      <li key={v.id}>
                        <Link to="/templates/$typeId/variants/$variantId" params={{ typeId: type.id, variantId: v.id }} search={{ unit: undefined }} className="flex items-center gap-2 text-[13px] hover:underline">
                          <span className="font-medium">{v.name}</span>
                          <span className="text-xs text-muted">
                            {v.unitId !== unitId
                              ? t('{fields} · from {unit}', { fields: plural(v.fields.length, '+{n} field', '+{n} fields'), unit: unitById.get(v.unitId)?.name ?? '' })
                              : plural(v.fields.length, '+{n} field', '+{n} fields')}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
      </Card>
    </div>
  );
}

/** Catalogs owned by this unit and its sub-units, plus creating one (managers). */
function CatalogsTab({ unitId, catalogs }: { unitId: string; catalogs: Catalog[] }) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const canCreate = useMyOrg().unitPermissionsOn(unitId).has('manage');
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 sm:px-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted">{t('Collections of this unit’s assets that it can share with other teams, divisions or people.')}</p>
        {canCreate && (
          <Button icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
            {t('New catalog')}
          </Button>
        )}
      </div>
      {catalogs.length ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {catalogs.map((c) => (
            <CatalogCard key={c.id} catalog={c} />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState title={t('No catalogs')} description={canCreate ? t('Group assets — licenses, lab equipment, tools — into a catalog to share them with the teams that use them.') : t('Its managers can create catalogs to share assets with other teams.')} />
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
        <span className="text-[13px] font-semibold">{t('Sub-units')}</span>
        <ExportButton onExport={() => exportRows(t('{unit} sub-units', { unit: unitById.get(unitId)?.name ?? t('Unit') }), SUB_UNIT_COLUMNS, rows)} />
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
    header: t('Unit'),
    meta: { sortKey: 'name', sortValue: (row) => row.unit.name },
    cell: ({ row: { original: { unit } } }) => (
      <span className="flex items-center gap-2 font-medium">
        <span className="size-2 rounded-full" style={{ background: unit.color }} />
        {unit.name}
        <span className="text-xs font-normal text-subtle">{tMaybe(unit.kind)}</span>
      </span>
    ),
  },
  { id: 'open', header: t('Open items'), meta: { sortKey: 'open', align: 'right', sortValue: (row) => row.r?.openItems ?? 0 }, cell: ({ row }) => row.original.r?.openItems ?? 0 },
  {
    id: 'overdue',
    header: t('Overdue'),
    meta: { sortKey: 'overdue', align: 'right', sortValue: (row) => row.r?.overdue ?? 0 },
    cell: ({ row }) => (row.original.r?.overdue ? <span className="font-medium text-danger">{row.original.r.overdue}</span> : 0),
  },
  { id: 'renewing', header: t('Renewing ≤ 90 days'), meta: { sortKey: 'renewing', align: 'right', sortValue: (row) => row.r?.renewingNext90 ?? 0 }, cell: ({ row }) => row.original.r?.renewingNext90 ?? 0 },
  { id: 'spend', header: t('Next 12 months'), meta: { sortKey: 'spend', align: 'right', sortValue: (row) => spendTotal(row.r), csvValue: (row) => money(row.r?.spendNext365) }, cell: ({ row }) => money(row.original.r?.spendNext365) },
];

function UpcomingFor({ unitId, canEdit }: { unitId: string; canEdit: Parameters<typeof ObligationList>[0]['canEdit'] }) {
  const today = todayIso();
  const items = useObligations({ unitId, state: 'active', to: addDuration(today, { amount: 120, unit: 'day' }), limit: 15 });
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-[13px] font-semibold">{t('Coming up in the next 4 months')}</span>
        <Link to="/" className="text-xs text-accent-fg hover:underline">
          {t('All upcoming')}
        </Link>
      </div>
      {items.data?.items.length ? <ObligationList items={items.data.items} canEdit={canEdit} /> : <p className="px-4 py-6 text-center text-xs text-muted">{items.isLoading ? t('Loading…') : t('Nothing due soon.')}</p>}
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
                <RequestStatusBadge status={r.statusInfo} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Inbox />} title={empty ?? t('Nothing here')} />
      )}
    </Card>
  );
}

/**
 * Members and managers. Directory-synced people are read-only here; managers
 * can add people by hand. `bare`: inside another card (the Organization editor);
 * `directory`: sign-in places people from a directory, so the hand-added are the exceptions.
 */
export function PeopleTab({ unitId, people, editable, bare = false, directory = true }: { unitId: string; people: UnitPerson[]; editable: boolean; bare?: boolean; directory?: boolean }) {
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
      toast.success(t('People updated'), { description: t('Their access changes at their next sign-in or within 15 minutes.') });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Could not update people')),
  });
  const groups: Array<{ role: UnitRole; title: string; hint: string; empty: string }> = [
    { role: 'manager', title: t('Managers'), hint: t('Manage everything in this unit and below it, and are told about its requests and orphaned renewals.'), empty: t('No managers yet') },
    { role: 'member', title: t('Members'), hint: t('See this unit’s assets and can request things for it.'), empty: t('No members yet') },
  ];
  return (
    <div className={bare ? 'space-y-4' : 'mx-auto w-full max-w-4xl space-y-6 px-4 sm:px-6 py-6'}>
      {editable && (
        <Card className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <p className="mb-1.5 text-xs font-medium text-muted">{directory ? t('Add someone who isn’t in the directory group') : t('Add a person')}</p>
            <PersonPicker value={adding} onChange={setAdding} placeholder={t('Search people')} />
          </div>
          <Select className="w-32" value={role} onChange={(e) => setRole(e.target.value as UnitRole)}>
            <option value="member">{t('Member')}</option>
            <option value="manager">{t('Manager')}</option>
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
            {t('Add')}
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
                    <Badge>{p.source === 'directory' ? t('From directory') : t('Added by hand')}</Badge>
                    {editable && p.source === 'manual' && (
                      <Button size="icon" variant="ghost" aria-label={t('Remove')} icon={<Trash2 className="size-3.5" />} onClick={() => save.mutate(manual.filter((m) => !(m.id === p.id && m.role === p.role)))} />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Users />} title={g.empty} />
            )}
          </Card>
        );
      })}
    </div>
  );
}
