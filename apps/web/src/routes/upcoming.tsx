import { addDuration, atLeast, effectiveLevel, type Obligation } from '@am/core';
import { CheckCircle2, Inbox } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DateKindBadge } from '@/components/badges';
import { ObligationList } from '@/components/obligations';
import { Card, EmptyState, PageHeader, Skeleton, Stat } from '@/components/ui/display';
import { Segmented, Select } from '@/components/ui/form';
import { useDateKinds, useMe, useObligations, useSummary } from '@/lib/queries';
import { formatMoney, todayIso } from '@/lib/utils';

const groupsOf = (items: Obligation[], today: string) => {
  const week = addDuration(today, { amount: 7, unit: 'day' });
  const month = addDuration(today, { amount: 30, unit: 'day' });
  return [
    { key: 'overdue', title: 'Overdue', items: items.filter((o) => o.dueDate < today) },
    { key: 'week', title: 'Next 7 days', items: items.filter((o) => o.dueDate >= today && o.dueDate <= week) },
    { key: 'month', title: 'Next 30 days', items: items.filter((o) => o.dueDate > week && o.dueDate <= month) },
    { key: 'later', title: 'Later', items: items.filter((o) => o.dueDate > month) },
  ].filter((g) => g.items.length);
};

export function UpcomingPage() {
  const me = useMe().data!;
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [kind, setKind] = useState('');
  const kinds = useDateKinds();
  const summary = useSummary();
  const today = todayIso();
  const obligations = useObligations({ state: 'active', to: addDuration(today, { amount: 1, unit: 'year' }), mine: scope === 'mine', dateKindId: kind || undefined, limit: 500 });
  const groups = useMemo(() => groupsOf(obligations.data?.items ?? [], today), [obligations.data, today]);
  const canEdit = (o: Obligation) => atLeast(effectiveLevel(me, { purchaseClassId: o.purchaseClassId, assetTypeId: o.assetTypeId }), 'edit');
  const spend = summary.data?.spend[0];
  const hour = new Date().getHours();

  return (
    <>
      <PageHeader
        title={`Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${me.displayName.split(' ')[0]}`}
        description="Renewals, deadlines and expiries that need attention."
        actions={
          <>
            <Select className="w-44" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All date kinds</option>
              {(kinds.data ?? [])
                .filter((k) => k.behavior !== 'informational')
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
            </Select>
            <Segmented value={scope} onChange={setScope} options={[{ value: 'all', label: 'Everything' }, { value: 'mine', label: 'Mine' }]} />
          </>
        }
      />
      <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Overdue" value={summary.data?.overdue ?? '–'} tone={summary.data?.overdue ? 'danger' : undefined} />
          <Stat label="Due in 7 days" value={summary.data?.dueThisWeek ?? '–'} tone={summary.data?.dueThisWeek ? 'warning' : undefined} />
          <Stat label="Due in 30 days" value={summary.data?.dueThisMonth ?? '–'} />
          <Stat label="Renewing in 90 days" value={spend ? formatMoney(spend.next90, spend.currency, true) : '–'} hint={spend ? `${formatMoney(spend.next30, spend.currency, true)} in the next 30 days` : 'Recurring spend'} />
        </div>

        {obligations.isLoading ? (
          <Card className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </Card>
        ) : !groups.length ? (
          <Card>
            <EmptyState icon={scope === 'mine' ? <Inbox /> : <CheckCircle2 />} title="You're all caught up" description="Nothing is due in the next year. Tracked dates on assets show up here automatically." />
          </Card>
        ) : (
          groups.map((g) => (
            <section key={g.key}>
              <div className="mb-2 flex items-center gap-2 px-1">
                <h2 className={g.key === 'overdue' ? 'text-[13px] font-semibold text-danger' : 'text-[13px] font-semibold'}>{g.title}</h2>
                <span className="text-xs text-subtle">{g.items.length}</span>
                <span className="ml-auto flex gap-1">
                  {[...new Map(g.items.map((o) => [o.dateKind.id, o.dateKind])).values()].slice(0, 4).map((k) => (
                    <DateKindBadge key={k.id} kind={k} />
                  ))}
                </span>
              </div>
              <Card padded={false} className="overflow-hidden">
                <ObligationList items={g.items} canEdit={canEdit} />
              </Card>
            </section>
          ))
        )}
      </div>
    </>
  );
}
