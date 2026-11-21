import { type PurchaseRequest, type RequestEvent, type RequestQuery, type RequestStatusInfo } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ExternalLink, RefreshCw, Inbox, MessageSquare, PackageCheck, Pencil, Plus, Search, ShoppingCart, UserRound, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { AssetFormSheet } from '@/components/asset-form';
import { useDebounced } from '@/lib/hooks';
import { RequestStatusBadge } from '@/components/badges';
import { Highlight } from '@/components/highlight';
import { AssetTypeSelect, PersonName, PersonPicker, UnitPath } from '@/components/pickers';
import { RequestFormSheet, useNewRequest } from '@/components/request-form';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, Card, CompactSteps, EmptyState, PageHeader, Skeleton, Spinner, Tabs } from '@/components/ui/display';
import { Field, Input, Segmented, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { keys, useLookups, useMe, usePeople, useRequest, useRequestCounts, useRequestEvents, useRequests } from '@/lib/queries';
import { cn, formatDate, formatDateTime, formatMoney, relativeDays } from '@/lib/utils';
import { useRemember } from '@/lib/recent';
import { plural, t, tMaybe } from '@/lib/i18n';
import { tj } from '@/lib/i18n-react';

// ─── List ────────────────────────────────────────────────────────────────────

export function RequestsPage() {
  const counts = useRequestCounts();
  const handles = (counts.data?.handle ?? 0) > 0;
  const [scope, setScope] = useState<RequestQuery['scope'] | null>(null);
  const active = scope ?? (handles ? 'handle' : 'mine');
  const [status, setStatus] = useState<'open' | 'closed' | 'all'>('open');
  const [kind, setKind] = useState<'all' | 'purchase' | 'renewal'>('all');
  const [q, setQ] = useState('');
  const search = useDebounced(q);
  const [unassigned, setUnassigned] = useState(false);
  const me = useMe().data!;
  const requests = useRequests({ scope: active, status, q: search || undefined, limit: 100, ...(kind !== 'all' && { kind }) });
  const newRequest = useNewRequest();
  const navigate = useNavigate();
  const items = (requests.data?.items ?? []).filter((r) => !unassigned || !r.assigneeId);

  const tabs = [
    ...(handles ? [{ value: 'handle', label: t('To handle'), count: counts.data?.handle }] : []),
    { value: 'mine', label: t('My requests'), count: counts.data?.mine },
    { value: 'team', label: t('My teams'), count: counts.data?.team },
    { value: 'all', label: t('Everything I can see') },
  ];

  return (
    <>
      <PageHeader
        title={t('Requests')}
        description={handles ? t('What people across the company have asked for, and where each request stands.') : t('Ask for software, hardware or services; track what you asked for.')}
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={newRequest}>
            {t('Request something')}
          </Button>
        }
      >
        <Tabs value={active} onValueChange={(v) => setScope(v as RequestQuery['scope'])} tabs={tabs} />
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 sm:px-6 py-3">
        <div className="relative w-80">
          <Search className="pointer-events-none absolute top-1/2 start-2.5 size-3.5 -translate-y-1/2 text-subtle" />
          <Input className="ps-8" placeholder={t('Search requests…')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented value={status} onChange={setStatus} options={[{ value: 'open', label: t('Open') }, { value: 'closed', label: t('Closed') }, { value: 'all', label: t('All') }]} />
        <Segmented value={kind} onChange={setKind} options={[{ value: 'all', label: t('Everything') }, { value: 'purchase', label: t('Purchases') }, { value: 'renewal', label: t('Renewals') }]} />
        {active === 'handle' && (
          <button type="button" onClick={() => setUnassigned((u) => !u)} className={cn('h-7 rounded-lg border px-2.5 text-xs font-medium', unassigned ? 'border-accent bg-accent-soft text-accent-fg' : 'border-border text-muted')}>
            {t('Unassigned')}{counts.data?.unassigned ? ` · ${counts.data.unassigned}` : ''}
          </button>
        )}
        <span className="ms-auto text-xs text-subtle">{requests.data ? plural(requests.data.total, '{n} request', '{n} requests') : ''}</span>
      </div>
      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-5">
        <Card padded={false} className="overflow-hidden">
          {requests.isLoading ? (
            <div className="space-y-3 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : !items.length ? (
            <EmptyState
              icon={<Inbox />}
              title={q ? t('No matching requests') : active === 'handle' ? t('Nothing waiting for you') : t('No requests here yet')}
              description={active === 'mine' && !q ? t('When you need software, hardware or a service, ask here and follow its progress.') : undefined}
              action={active === 'mine' && !q ? <Button variant="primary" onClick={newRequest}>{t('Request something')}</Button> : undefined}
            />
          ) : (
            <ul className="divide-y divide-border">
              {items.map((r) => (
                <RequestRow key={r.id} r={r} meId={me.userId} onOpen={() => void navigate({ to: '/requests/$requestId', params: { requestId: r.id } })} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function RequestRow({ r, meId, onOpen }: { r: PurchaseRequest; meId: string; onOpen: () => void }) {
  const { typeById } = useLookups();
  const type = r.assetTypeId ? typeById.get(r.assetTypeId) : undefined;
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-surface-2/50">
        {r.kind === 'renewal' ? (
          <span className="flex size-[30px] items-center justify-center rounded-lg bg-accent-soft text-accent-fg" title={t('Renewal')}>
            <RefreshCw className="size-4" />
          </span>
        ) : type ? (
          <TypeIcon icon={type.icon} color={type.color} size={30} />
        ) : (
          <span className="flex size-[30px] items-center justify-center rounded-lg bg-surface-2 text-muted">
            <ShoppingCart className="size-4" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{r.title}</span>
            <span className="hidden shrink-0 text-xs text-subtle sm:inline">{r.number}</span>
          </span>
          {/* Phones: the status gets its own line, so a long one does not squeeze the title. */}
          <span className="my-0.5 flex sm:hidden">
            <OverallBadge r={r} />
          </span>
          {r.snippet ? (
            <Highlight snippet={r.snippet} className="block truncate text-xs text-muted" />
          ) : (
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted sm:flex-nowrap">
              <span className="text-subtle sm:hidden">{r.number}</span>
              <span className="text-subtle sm:hidden">·</span>
              <span className="hidden min-w-0 sm:inline-flex">
                <UnitPath id={r.unitId} />
              </span>
              <span className="hidden text-subtle sm:inline">·</span>
              <span className="truncate">{r.requesterId === meId ? t('You') : r.requesterName}</span>
              <span className="text-subtle">·</span>
              <span>{relativeDays(r.createdAt.slice(0, 10))}</span>
              {r.neededBy && (
                <>
                  <span className="text-subtle">·</span>
                  <span>{t('needed {date}', { date: formatDate(r.neededBy, true) })}</span>
                </>
              )}
            </span>
          )}
        </span>
        {r.commentCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-subtle">
            <MessageSquare className="size-3.5" />
            {r.commentCount}
          </span>
        )}
        <span className="hidden sm:contents">{r.assigneeId ? <AssigneeAvatar id={r.assigneeId} /> : <span className="w-[22px]" />}</span>
        <span className="hidden sm:contents">
          <OverallBadge r={r} />
        </span>
      </button>
    </li>
  );
}

function AssigneeAvatar({ id }: { id: string }) {
  const p = usePeople([id]).get(id);
  return <Avatar name={p?.displayName ?? '?'} size={22} />;
}

/**
 * One status for the whole request: the purchase's while it is open or was
 * called off; once bought, whichever added workflow is still open
 * ("Swap the new license: To install"), else done.
 */
export function OverallBadge({ r }: { r: PurchaseRequest }) {
  const open = r.workflows.filter((w) => r.overall.waitingOn.includes(w.key) && w.statusInfo);
  if (r.overall.waitingOn.includes('purchase') || !open.length) return <RequestStatusBadge status={r.statusInfo} />;
  const first = open[0]!;
  return (
    <span className="inline-flex items-center gap-1" title={open.map((w) => `${tMaybe(w.name)}: ${tMaybe(w.statusInfo!.label)}`).join(' · ')}>
      <RequestStatusBadge status={{ label: `${tMaybe(first.name)}: ${tMaybe(first.statusInfo!.label)}`, color: first.statusInfo!.color }} />
      {open.length > 1 && <span className="text-xs text-muted">+{open.length - 1}</span>}
    </span>
  );
}

/**
 * Every workflow of the request, for everyone: the purchase and the ones the
 * template or the item's team added, each with the unit responsible for it
 * and where it stands. The responsible unit moves its own.
 */
function WorkflowsCard({ r, onMove, pending }: { r: PurchaseRequest; onMove: (workflow: string, status: string) => void; pending: boolean }) {
  const waitingOther = r.overall.waitingOn.filter((k) => k !== 'purchase');
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-[13px] font-semibold">{t('Where it stands')}</h2>
        <p className="text-xs text-muted">
          {r.overall.category === 'done'
            ? t('Done for everyone.')
            : r.overall.category === 'closed'
              ? t('This request is closed.')
              : waitingOther.length && !r.overall.waitingOn.includes('purchase')
                ? t('Bought — still waiting on: {names}', { names: r.workflows.filter((w) => waitingOther.includes(w.key)).map((w) => tMaybe(w.name)).join(', ') })
                : t('Each part is moved by the unit responsible for it.')}
        </p>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">
            <span className="font-medium">{r.kind === 'renewal' ? t('Renewal') : t('Purchase')}</span>
            <span className="ms-2 text-xs text-muted">{r.responsibleUnitId ? <UnitPath id={r.responsibleUnitId} leafOnly /> : t('People who handle requests')}</span>
          </span>
          <RequestStatusBadge status={r.statusInfo} />
        </li>
        {r.workflows.map((w) => (
          <li key={w.key} className="space-y-2 px-3 py-2.5 text-[13px]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{tMaybe(w.name)}</span>
                <span className="ms-2 text-xs text-muted">
                  <UnitPath id={w.responsibleUnitId} leafOnly />
                </span>
              </span>
              {w.statusInfo ? <RequestStatusBadge status={w.statusInfo} /> : <Badge>{t('Starts when bought')}</Badge>}
            </div>
            {w.moves.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {w.moves.map((m) => (
                  <Button key={m.key} size="sm" variant={m.category === 'done' ? 'primary' : m.category === 'closed' ? 'ghost' : 'secondary'} disabled={pending} icon={m.category === 'done' ? <Check className="size-3.5" /> : m.category === 'closed' ? <X className="size-3.5" /> : <ArrowRight className="size-3.5" />} onClick={() => onMove(w.key, m.key)}>
                    {tMaybe(m.label)}
                  </Button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ─── Detail ──────────────────────────────────────────────────────────────────

/** Progress through the request's own workflow: its open statuses, then its first done one. */
function Stepper({ r }: { r: PurchaseRequest }) {
  const current = r.statusInfo;
  if (current.category === 'closed') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px] font-medium text-muted">
        <X className="size-4" style={{ color: current.color }} /> {t('{status} — this request is closed', { status: tMaybe(current.label) })}
      </div>
    );
  }
  const done = current.category === 'done' ? current : r.statuses.find((s) => s.category === 'done');
  const steps = [...r.statuses.filter((s) => s.category === 'todo' || s.category === 'active'), ...(done ? [done] : [])];
  const at = steps.findIndex((s) => s.key === current.key);
  const finished = current.category === 'done';
  return (
    <>
    <CompactSteps className="sm:hidden" index={Math.max(at, 0)} total={steps.length} label={tMaybe(current.label)} color={current.color} done={finished} />
    <ol className="hidden items-center gap-1 overflow-x-auto sm:flex">
      {steps.map((s, i) => (
        <li key={s.key} className="flex flex-1 items-center gap-1">
          <span
            className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', i < at || finished ? 'bg-success text-white' : i === at ? 'text-white' : 'bg-surface-3 text-subtle')}
            style={i === at && !finished ? { background: s.color } : undefined}
          >
            {i < at || finished ? <Check className="size-3" strokeWidth={3} /> : i + 1}
          </span>
          <span className={cn('text-xs whitespace-nowrap', i <= at ? 'font-medium text-fg' : 'text-subtle')}>{tMaybe(s.label)}</span>
          {i < steps.length - 1 && <span className={cn('mx-1 h-px min-w-3 flex-1', i < at ? 'bg-success' : 'bg-border')} />}
        </li>
      ))}
    </ol>
    </>
  );
}

function useAct(requestId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<PurchaseRequest>(`/api/registry/requests/${requestId}/actions`, body),
    onSuccess: (r, body) => {
      void qc.invalidateQueries({ queryKey: keys.requests });
      if (body.action === 'status' && body.workflow) {
        const w = r.workflows.find((x) => x.key === body.workflow);
        if (w?.statusInfo) toast.success(t('{workflow}: moved to “{status}”', { workflow: tMaybe(w.name), status: tMaybe(w.statusInfo.label) }));
      } else if (body.action === 'status') {
        toast.success(t('Moved to “{status}”', { status: tMaybe(r.statusInfo.label) }));
        // A finished renewal moved the item's date.
        if (r.kind === 'renewal' && r.statusInfo.category === 'done') void qc.invalidateQueries();
      }
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Something went wrong')),
  });
}

export function RequestDetailPage() {
  const { requestId } = useParams({ strict: false }) as { requestId: string };
  const request = useRequest(requestId);
  const events = useRequestEvents(requestId);
  const me = useMe().data!;
  const { typeById, variantById, unitById, schemaOf, kindById } = useLookups();
  const act = useAct(requestId);
  useRemember(request.data ? { kind: 'request', id: request.data.id, title: request.data.title, subtitle: t('Request') } : null);
  const [comment, setComment] = useState('');
  const [closing, setClosing] = useState<RequestStatusInfo | null>(null);
  const [renewing, setRenewing] = useState<RequestStatusInfo | null>(null);
  const [renewedUntil, setRenewedUntil] = useState('');
  // A renewed date with no fixed term needs its new date (it cannot roll forward by itself).
  const renewalField = request.data?.renewal ? schemaOf(request.data.assetTypeId ?? '', request.data.variantId)?.fields.find((f) => f.key === request.data!.renewal!.fieldKey) : undefined;
  const tracking = renewalField?.kind === 'date' ? renewalField.config.tracking : undefined;
  const needsUntil = !!tracking && (tracking.recurrence?.mode === 'manual' || (tracking.recurrence === undefined && !kindById.get(tracking.dateKindId)?.defaultRecurrence));
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [fulfilType, setFulfilType] = useState<string | null>(null);
  const [choosingType, setChoosingType] = useState(false);

  if (request.isLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!request.data) return <EmptyState title={t('Request not found')} description={t('It may not exist, or you may not have access.')} action={<Link to="/requests" className="text-accent-fg">{t('Back to requests')}</Link>} />;

  const r = request.data;
  const handler = r.access === 'handler';
  const mine = r.requesterId === me.userId;
  const type = r.assetTypeId ? typeById.get(r.assetTypeId) : undefined;
  const teamVariant = r.kind === 'purchase' && r.variantId ? variantById.get(r.variantId) : undefined;
  const open = r.statusInfo.category === 'todo' || r.statusInfo.category === 'active';
  const fulfilAs = fulfilType ? typeById.get(fulfilType) : undefined;
  const status = (s: string, note?: string) => act.mutate({ action: 'status', status: s, ...(note && { note }) });

  // The buttons are the workflow's next statuses: forward moves first, then the ones that close it.
  const actions: ReactNode[] = [];
  const forward = r.moves.filter((m) => m.category !== 'closed');
  const primary = forward.find((m) => m.category === 'done') ?? forward.find((m) => m.category === 'active');
  for (const m of forward)
    actions.push(
      <Button key={m.key} variant={m === primary ? 'primary' : 'secondary'} icon={m.category === 'done' ? <Check className="size-3.5" /> : <ArrowRight className="size-3.5" />} loading={act.isPending && act.variables?.status === m.key} onClick={() => (r.kind === 'renewal' && m.category === 'done' ? setRenewing(m) : status(m.key))}>
        {r.kind === 'renewal' && m.category === 'done' ? t('{status} — roll the date forward', { status: tMaybe(m.label) }) : tMaybe(m.label)}
      </Button>,
    );
  if (handler && open && r.kind === 'purchase' && r.statusInfo.category === 'active')
    actions.push(
      <Button key="ful" variant={primary ? 'secondary' : 'primary'} icon={<PackageCheck className="size-3.5" />} onClick={() => (r.assetTypeId ? setFulfilType(r.assetTypeId) : setChoosingType(true))}>
        {t('Create the item — done')}
      </Button>,
    );
  for (const m of r.moves.filter((x) => x.category === 'closed'))
    actions.push(
      <Button key={m.key} variant={handler ? 'danger-ghost' : 'ghost'} icon={<X className="size-3.5" />} onClick={() => (handler ? setClosing(m) : status(m.key))}>
        {tMaybe(m.label)}
      </Button>,
    );
  return (
    <>
      <PageHeader
        title={r.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link to="/requests" className="inline-flex items-center gap-1 hover:text-fg">
              <ArrowLeft className="size-3" /> {t('Requests')}
            </Link>
            <span>{r.number}</span>
            <OverallBadge r={r} />
            {r.kind === 'renewal' && <Badge tone="accent">{t('Renewal')}</Badge>}
          </span>
        }
        actions={(handler || (mine && r.statusInfo.category === 'todo')) && open && <Button icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>{t('Edit')}</Button>}
      />
      <div className="mx-auto grid grid-cols-1 w-full max-w-6xl gap-6 px-4 sm:px-6 py-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card className="space-y-3">
            {/* With more workflows, this is the buyers' part only; "Where it stands" shows the rest. */}
            {r.workflows.length > 0 && (
              <p className="text-[13px] font-semibold">
                {r.kind === 'renewal' ? t('Renewal') : t('Purchase')}
                <span className="ms-2 text-xs font-normal text-muted">{r.responsibleUnitId ? <UnitPath id={r.responsibleUnitId} leafOnly /> : t('People who handle requests')}</span>
              </p>
            )}
            <Stepper r={r} />
          </Card>
          {r.workflows.length > 0 && <WorkflowsCard r={r} pending={act.isPending} onMove={(workflow, s) => act.mutate({ action: 'status', status: s, workflow })} />}
          <Card className="space-y-4">
            {r.description ? <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{r.description}</p> : <p className="text-[13px] text-subtle">{t('No details given.')}</p>}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] xl:grid-cols-4">
              <Detail label={t('Kind')}>{type ? <span className="inline-flex items-center gap-1.5"><TypeIcon icon={type.icon} color={type.color} size={18} />{type.name}</span> : t('Not specified')}</Detail>
              {teamVariant && (
                <Detail label={t('For {team}, this is', { team: unitById.get(teamVariant.unitId)?.name ?? '' })}>
                  <span title={t('The item gets {team}’s fields; they fill them in.', { team: unitById.get(teamVariant.unitId)?.name ?? '' })}>{teamVariant.name}</span>
                </Detail>
              )}
              <Detail label={t('Quantity')}>{r.quantity ?? '—'}</Detail>
              <Detail label={t('Rough budget')}>{r.estimatedCost ? formatMoney(r.estimatedCost.amount, r.estimatedCost.currency) : '—'}</Detail>
              <Detail label={t('Needed by')}>{r.neededBy ? `${formatDate(r.neededBy)} · ${relativeDays(r.neededBy)}` : '—'}</Detail>
            </dl>
            {r.link && (
              <a href={r.link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[13px] text-accent-fg hover:underline">
                {new URL(r.link).host} <ExternalLink className="size-3" />
              </a>
            )}
            {r.renewal && (
              <Link to="/assets/$assetId" params={{ assetId: r.renewal.assetId }} className="flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px] font-medium text-accent-fg">
                <RefreshCw className="size-4" /> {r.statusInfo.category === 'done' ? t('Renewed — open the item') : t('Renewing an existing item — open it')}
              </Link>
            )}
            {r.assetId && r.kind === 'purchase' && (
              <Link to="/assets/$assetId" params={{ assetId: r.assetId }} className="flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2 text-[13px] font-medium text-success">
                <CheckCircle2 className="size-4" /> {t('Fulfilled — open the asset')}
              </Link>
            )}
          </Card>
          <Card>
            <h2 className="mb-4 text-[13px] font-semibold">{t('Activity')}</h2>
            <Timeline events={events.data ?? []} statuses={r.statuses} workflows={r.workflows} renewal={r.kind === 'renewal'} />
            <form
              className="mt-4 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (comment.trim()) act.mutate({ action: 'comment', body: comment.trim() }, { onSuccess: () => setComment('') });
              }}
            >
              <Textarea rows={3} placeholder={handler ? t('Ask a question or post an update — the requester gets an email.') : t('Add a comment — the people handling this get an email.')} value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="flex justify-end">
                <Button type="submit" variant="primary" disabled={!comment.trim()} loading={act.isPending && act.variables?.action === 'comment'}>
                  {t('Comment')}
                </Button>
              </div>
            </form>
          </Card>
        </div>
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          {actions.length > 0 && (
            <Card className="space-y-2">
              <h2 className="mb-1 text-[13px] font-semibold">{handler ? t('Next step') : t('Actions')}</h2>
              <div className="flex flex-col gap-2 [&>button]:justify-center">{actions}</div>
            </Card>
          )}
          <Card className="space-y-3 text-[13px]">
            <Detail label={t('For')}>
              <UnitPath id={r.unitId} />
            </Detail>
            <Detail label={t('Requested by')}>
              <PersonName id={r.requesterId} />
            </Detail>
            <Detail label={t('Handled by')}>
              {handler && open ? (
                <div className="space-y-1.5">
                  <PersonPicker value={r.assigneeId} onChange={(assigneeId) => act.mutate({ action: 'assign', assigneeId })} placeholder={t('Unassigned')} />
                  {r.assigneeId !== me.userId && (
                    <Button size="xs" variant="ghost" icon={<UserRound className="size-3" />} onClick={() => act.mutate({ action: 'assign', assigneeId: me.userId })}>
                      {t('Assign to me')}
                    </Button>
                  )}
                </div>
              ) : (
                <PersonName id={r.assigneeId} fallback={t('Not picked up yet')} />
              )}
            </Detail>
            <Detail label={t('Requested')}>{formatDateTime(r.createdAt)}</Detail>
          </Card>
        </div>
      </div>

      <RequestFormSheet open={editing} onOpenChange={setEditing} request={r} />
      <Dialog
        open={!!closing}
        onOpenChange={(o) => !o && setClosing(null)}
        title={t('{status} — close this request', { status: closing ? tMaybe(closing.label) : t('Close') })}
        description={t('Say why, so the requester knows what to do instead.')}
        footer={
          <>
            <Button onClick={() => setClosing(null)}>{t('Cancel')}</Button>
            <Button variant="danger" disabled={!reason.trim()} onClick={() => (status(closing!.key, reason.trim()), setClosing(null), setReason(''))}>
              {closing && tMaybe(closing.label)}
            </Button>
          </>
        }
      >
        <Textarea autoFocus rows={4} placeholder={t('e.g. We already have a company-wide FigJam license — ask IT to add you.')} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Dialog>
      <Dialog
        open={!!renewing}
        onOpenChange={(o) => !o && (setRenewing(null), setRenewedUntil(''))}
        title={renewing ? t('{status} — renewed until?', { status: tMaybe(renewing.label) }) : ''}
        description={
          needsUntil
            ? t('This date has no fixed term: set the new one. Reminders and the next renewal follow it.')
            : t('Leave empty to roll the date forward by its usual term. Set it when you got something else, e.g. a year and 10 days, or when the date has no fixed term.')
        }
        footer={
          <>
            <Button onClick={() => (setRenewing(null), setRenewedUntil(''))}>{t('Cancel')}</Button>
            <Button
              variant="primary"
              disabled={needsUntil && !renewedUntil}
              onClick={() => {
                act.mutate({ action: 'status', status: renewing!.key, ...(renewedUntil && { renewedUntil }) });
                setRenewing(null);
                setRenewedUntil('');
              }}
            >
              {renewing && tMaybe(renewing.label)}
            </Button>
          </>
        }
      >
        <Field label={t('Renewed until')}>{(id) => <Input id={id} type="date" value={renewedUntil} onChange={(e) => setRenewedUntil(e.target.value)} />}</Field>
      </Dialog>
      <Dialog
        open={choosingType}
        onOpenChange={setChoosingType}
        title={t('What are you adding?')}
        description={t('Pick the kind of asset this request becomes.')}
        footer={
          <Button variant="primary" disabled={!fulfilType} onClick={() => setChoosingType(false)}>
            {t('Continue')}
          </Button>
        }
      >
        <Field label={t('Asset type')}>{(id) => <AssetTypeSelect id={id} value={fulfilType} onChange={setFulfilType} />}</Field>
      </Dialog>
      {fulfilAs && !choosingType && <AssetFormSheet open onOpenChange={(o) => !o && setFulfilType(null)} type={fulfilAs} request={r} />}
    </>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-xs text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Timeline({ events, statuses, workflows, renewal }: { events: RequestEvent[]; statuses: RequestStatusInfo[]; workflows: PurchaseRequest['workflows']; renewal: boolean }) {
  const label = (key: string, workflow?: string | null) => (workflow ? workflows.find((w) => w.key === workflow)?.statuses : statuses)?.find((s) => s.key === key) ?? { label: key.replace(/_/g, ' '), color: '#94a3b8' };
  const ids = events.filter((e) => e.kind === 'assigned' && e.body).map((e) => e.body!);
  const people = usePeople(ids);
  const line = (e: RequestEvent): ReactNode => {
    const actor = <span className="font-medium text-fg">{e.actorName}</span>;
    const badge = () => <RequestStatusBadge status={label(e.toStatus!, e.workflow)} />;
    if (e.workflow) {
      const name = tMaybe(workflows.find((w) => w.key === e.workflow)?.name ?? e.workflow);
      return e.fromStatus ? tj('{actor} moved {workflow} to {status}', { actor, workflow: name, status: badge() }) : tj('{workflow} started: {status}', { workflow: name, status: badge() });
    }
    switch (e.kind) {
      case 'comment':
        return tj('{actor} commented', { actor });
      case 'created':
        return tj('{actor} submitted this request', { actor });
      case 'status':
        return tj('{actor} moved it to {status}', { actor, status: badge() });
      case 'assigned':
        return e.body ? tj('{actor} assigned it to {person}', { actor, person: people.get(e.body)?.displayName ?? '…' }) : tj('{actor} unassigned it', { actor });
      case 'edited':
        return tj('{actor} edited the details', { actor });
      case 'fulfilled':
        return e.body || renewal ? tj('{actor} finished it: {status}', { actor, status: badge() }) : tj('{actor} finished it by adding the item: {status}', { actor, status: badge() });
      default:
        return actor;
    }
  };
  return (
    <ol className="space-y-4">
      {events.map((e) => (
        <li key={e.id} className="flex gap-3">
          <Avatar name={e.actorName} size={26} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px]">
              <span className={e.kind === 'comment' ? 'text-subtle' : 'text-muted'}>{line(e)}</span>
              <span className="ms-2 text-xs text-subtle">{formatDateTime(e.at)}</span>
            </p>
            {e.body && e.kind !== 'assigned' && <p className="mt-1 rounded-lg bg-surface-2 px-3 py-2 text-[13px] whitespace-pre-wrap">{e.body}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
