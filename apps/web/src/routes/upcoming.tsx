import { addDuration, type Obligation, type RenewalDecision } from '@am/core';
import { AnswerDialog } from '@/components/renewal-check';
import { CircleHelp } from 'lucide-react';
import { formatDate } from '@/lib/utils';
import { useMyOrg } from '@/lib/org';
import { CheckCircle2, Inbox } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DateKindBadge } from '@/components/badges';
import { ObligationList } from '@/components/obligations';
import { Card, EmptyState, PageHeader, Skeleton, Stat } from '@/components/ui/display';
import { Segmented, Select } from '@/components/ui/form';
import { useDateKinds, useMe, useObligations, useRequestCounts, useRequests, useSummary } from '@/lib/queries';
import { useNewRequest } from '@/components/request-form';
import { RequestStatusBadge } from '@/components/badges';
import { Button } from '@/components/ui/button';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Plus, ShoppingCart } from 'lucide-react';
import { formatMoney, todayIso } from '@/lib/utils';

/** How many items a group shows before "Show all". */
const PREVIEW = 8;

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
  const [check, setCheck] = useState<'' | 'asked' | 'answered'>('');
  const kinds = useDateKinds();
  const summary = useSummary({ mine: scope === 'mine' });
  const today = todayIso();
  const obligations = useObligations({ state: 'active', to: addDuration(today, { amount: 1, unit: 'year' }), mine: scope === 'mine', dateKindId: kind || undefined, check: check || undefined, limit: 500 });
  const groups = useMemo(() => groupsOf(obligations.data?.items ?? [], today), [obligations.data, today]);
  // Long groups show their first items; "Show all" opens the rest in place.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const jump = (key: string) => () => document.getElementById(`due-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const canEdit = useCanEditObligation();
  const spend = summary.data?.spend[0];
  const hour = new Date().getHours();

  return (
    <>
      <PageHeader
        title={`Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${me.displayName.split(' ')[0]}`}
        description="Renewals, deadlines and expiries that need attention."
        actions={
          <>
            <Select className="w-auto sm:w-44" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All date kinds</option>
              {(kinds.data ?? [])
                .filter((k) => k.behavior !== 'informational')
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
            </Select>
            <Select className="w-auto sm:w-44" value={check} onChange={(e) => setCheck(e.target.value as typeof check)} aria-label="Renewal checks">
              <option value="">Any renewal check</option>
              <option value="asked">Waiting for owner</option>
              <option value="answered">Owner answered</option>
            </Select>
            <Segmented value={scope} onChange={setScope} options={[{ value: 'all', label: 'Everything' }, { value: 'mine', label: 'Mine' }]} />
          </>
        }
      />
      <div className="mx-auto w-full max-w-5xl space-y-6 px-4 sm:px-6 py-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Overdue" value={summary.data?.overdue ?? '–'} tone={summary.data?.overdue ? 'danger' : undefined} onClick={jump('overdue')} />
          <Stat label="Due in 7 days" value={summary.data?.dueThisWeek ?? '–'} tone={summary.data?.dueThisWeek ? 'warning' : undefined} onClick={jump('week')} />
          <Stat label="Due in 30 days" value={summary.data?.dueThisMonth ?? '–'} onClick={jump('month')} />
          <Stat label="Renewing in 90 days" value={spend ? formatMoney(spend.next90, spend.currency, true) : '–'} hint={spend ? `${formatMoney(spend.next30, spend.currency, true)} in the next 30 days` : 'Recurring spend'} />
        </div>

        <ChecksStrip />
        <RequestsStrip />

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
            <section key={g.key} id={`due-${g.key}`} className="scroll-mt-4">
              <div className="mb-2 flex items-center gap-2 px-1">
                <h2 className={g.key === 'overdue' ? 'text-[13px] font-semibold text-danger' : 'text-[13px] font-semibold'}>{g.title}</h2>
                <span className="text-xs text-subtle">{g.items.length}</span>
                <span className="ml-auto hidden flex-wrap justify-end gap-1 sm:flex">
                  {[...new Map(g.items.map((o) => [o.dateKind.id, o.dateKind])).values()].slice(0, 4).map((k) => (
                    <DateKindBadge key={k.id} kind={k} />
                  ))}
                </span>
              </div>
              <Card padded={false} className="overflow-hidden">
                <ObligationList items={expanded.has(g.key) ? g.items : g.items.slice(0, PREVIEW)} canEdit={canEdit} />
                {g.items.length > PREVIEW && (
                  <button
                    type="button"
                    onClick={() => setExpanded((s) => (s.has(g.key) ? new Set([...s].filter((k) => k !== g.key)) : new Set([...s, g.key])))}
                    className="flex w-full items-center justify-center gap-1.5 border-t border-border py-2.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-surface-2/60"
                  >
                    {expanded.has(g.key) ? 'Show fewer' : `Show all ${g.items.length}`}
                  </button>
                )}
              </Card>
            </section>
          ))
        )}
      </div>
    </>
  );
}

/** Acting on dates (renew, snooze, ask the owner) is the “Handle renewals” permission. */
function useCanEditObligation() {
  const { can } = useMyOrg();
  return (o: Obligation) => can(o.unitId, 'renew', o.assetTypeId);
}

/** "Do you still need it?" questions waiting for me, with one-click answers. */
function ChecksStrip() {
  const me = useMe().data!;
  const asked = useObligations({ check: 'asked', mine: true, limit: 20 });
  const [answering, setAnswering] = useState<{ o: Obligation; decision?: RenewalDecision } | null>(null);
  const mine = (asked.data?.items ?? []).filter((o) => o.ownerId === me.userId);
  if (!mine.length) return null;
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 px-1">
        <CircleHelp className="size-4 text-warning" />
        <h2 className="text-[13px] font-semibold">Waiting for your answer</h2>
        <span className="text-xs text-subtle">{mine.length}</span>
      </div>
      <Card padded={false} className="divide-y divide-border overflow-hidden border-warning/40">
        {mine.map((o) => (
          <div key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1 basis-64">
              <p className="text-[13px]">
                <Link to="/assets/$assetId" params={{ assetId: o.assetId }} className="font-medium hover:underline">
                  Do you still need {o.assetName}?
                </Link>
              </p>
              <p className="truncate text-xs text-muted">
                {o.label} {formatDate(o.dueDate)} · asked by {o.check?.askedByName}
                {o.check?.message ? ` — “${o.check.message}”` : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => setAnswering({ o, decision: 'renew' })}>
                Renew
              </Button>
              <Button size="sm" onClick={() => setAnswering({ o, decision: 'change' })}>
                With changes
              </Button>
              <Button size="sm" onClick={() => setAnswering({ o, decision: 'cancel' })}>
                Don’t renew
              </Button>
            </div>
          </div>
        ))}
      </Card>
      <AnswerDialog obligation={answering?.o ?? null} initial={answering?.decision} onClose={() => setAnswering(null)} />
    </section>
  );
}

/** Handlers see what waits for them; everyone sees where their own requests stand. */
function RequestsStrip() {
  const counts = useRequestCounts();
  const handles = (counts.data?.handle ?? 0) > 0;
  const mine = useRequests({ scope: 'mine', status: 'open', limit: 3 });
  const newRequest = useNewRequest();
  if (!counts.data) return null;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {handles && (
        <Link to="/requests" className="block">
          <Card className="flex h-full items-center gap-3 border-accent/30 bg-accent-soft/40 transition-colors hover:border-accent/60">
            <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-white">
              <ShoppingCart className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold">
                {counts.data.handle} open {counts.data.handle === 1 ? 'request' : 'requests'} to handle
              </span>
              <span className="block text-xs text-muted">{counts.data.unassigned ? `${counts.data.unassigned} not picked up yet` : 'All picked up'}</span>
            </span>
            <ArrowRight className="size-4 text-muted" />
          </Card>
        </Link>
      )}
      <Card className={handles ? '' : 'md:col-span-2'}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-semibold">Your requests</span>
          <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={newRequest}>
            Request something
          </Button>
        </div>
        {mine.data?.items.length ? (
          <ul className="space-y-1.5">
            {mine.data.items.map((r) => (
              <li key={r.id}>
                <Link to="/requests/$requestId" params={{ requestId: r.id }} className="flex items-center gap-2 text-[13px] hover:underline">
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <RequestStatusBadge status={r.statusInfo} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">Need software, hardware or a service? Ask here and follow it to delivery.</p>
        )}
      </Card>
    </div>
  );
}
