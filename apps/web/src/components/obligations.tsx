import { addDuration, type Obligation } from '@am/core';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { AlarmClock, Check, CircleHelp, ShoppingCart, MessageCircleQuestion, MoreHorizontal, RefreshCcw, RotateCcw, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { plural, t, tMaybe } from '@/lib/i18n';
import { useInvalidateAssets, useLookups, useMe, usePurchaseUnit } from '@/lib/queries';
import { useMyOrg } from '@/lib/org';
import { cn, formatDate, formatMoney, todayIso } from '@/lib/utils';
import { DateKindBadge, DueBadge, RequestStatusBadge } from './badges';
import { PersonName, UnitPath } from './pickers';
import { AnswerDialog, AskOwnerDialog, CheckBadge } from './renewal-check';
import { TypeIcon } from './type-icon';
import { Button } from './ui/button';
import { Input } from './ui/form';
import { Dialog, Menu, MenuItem, MenuSeparator } from './ui/overlay';

/**
 * The one place obligation actions are implemented. Recurring dates are
 * "advanced" in the registry (the source of truth for dates); other actions
 * change the occurrence in the scheduler.
 */
export function useObligationActions() {
  const invalidate = useInvalidateAssets();
  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('Something went wrong'));

  const advance = useMutation({
    mutationFn: ({ o, until }: { o: Obligation; until?: string }) => api.post(`/api/registry/assets/${o.assetId}/dates/${o.fieldKey}/advance`, until ? { until } : {}),
    onSuccess: (_d, { o, until }) => {
      toast.success(t('{action}: {asset}', { action: tMaybe(o.dateKind.actionLabel), asset: o.assetName }), { description: until ? t('{label} is now {date}', { label: o.label, date: formatDate(until) }) : t('{label} rolled forward', { label: o.label }) });
      invalidate(o.assetId);
    },
    onError,
  });
  const act = useMutation({
    mutationFn: ({ o, body }: { o: Obligation; body: Record<string, unknown> }) => api.post(`/api/scheduler/obligations/${o.id}/actions`, body),
    onSuccess: (_d, { o, body }) => {
      toast.success(body.action === 'snooze' ? t('Snoozed until {date}', { date: formatDate(body.until as string) }) : body.action === 'reopen' ? t('Reopened') : body.action === 'dismiss' ? t('Dismissed') : t('Marked complete'));
      invalidate(o.assetId);
    },
    onError,
  });

  const navigate = useNavigate();
  const renewal = useMutation({
    mutationFn: (o: Obligation) => api.post<{ id: string; number: string }>(`/api/registry/assets/${o.assetId}/renewal-requests`, { fieldKey: o.fieldKey, obligationId: o.id }),
    onSuccess: (r, o) => {
      toast.success(t('{number} opened', { number: r.number }), { description: t('Renewal of {asset}', { asset: o.assetName }) });
      invalidate(o.assetId);
      void navigate({ to: '/requests/$requestId', params: { requestId: r.id } });
    },
    onError,
  });

  return {
    requestRenewal: (o: Obligation) => renewal.mutate(o),
    primary: (o: Obligation) => (o.recurring ? advance.mutate({ o }) : act.mutate({ o, body: { action: 'complete' } })),
    /** Renewed until a given date ("a year and 10 days"), or a renewal with no fixed term. */
    renewUntil: (o: Obligation, until: string) => advance.mutate({ o, until }),
    snooze: (o: Obligation, until: string) => act.mutate({ o, body: { action: 'snooze', until } }),
    dismiss: (o: Obligation) => act.mutate({ o, body: { action: 'dismiss' } }),
    reopen: (o: Obligation) => act.mutate({ o, body: { action: 'reopen' } }),
    pending: advance.isPending || act.isPending,
  };
}

/** Who renews (rolls dates forward): the unit responsible for purchases, when there is one (and admins); otherwise whoever handles renewals. */
export function useIsBuyer() {
  const me = useMe().data;
  const purchase = usePurchaseUnit().data;
  const { mine, can } = useMyOrg();
  // With a purchase unit, its people renew everything, whatever their access to the item.
  if (!purchase?.unitId) return { buyer: true, everywhere: !!me?.isAdmin };
  // As the server: its people (and those of teams beneath it), anyone who manages it, and admins.
  const buyer = !!me?.isAdmin || mine.some((m) => m.unit.path.includes(purchase.unitId!)) || can(purchase.unitId, 'manage');
  return { buyer, everywhere: buyer };
}

/** A renewal with no fixed term needs its new date; any renewal can be given one ("bought a year, got a year and 10 days"). */
export const needsNewDate = (o: Pick<Obligation, 'recurring' | 'dateKind'>) => !o.recurring && o.dateKind.behavior === 'recurring';

function RenewUntilDialog({ obligation, onClose, onRenew }: { obligation: Obligation | null; onClose: () => void; onRenew: (until: string) => void }) {
  const [until, setUntil] = useState('');
  const o = obligation;
  const suggested = o ? addDuration(o.dueDate, { amount: 1, unit: 'year' }) : '';
  const value = until || suggested;
  return (
    <Dialog
      open={!!o}
      onOpenChange={(open) => !open && (onClose(), setUntil(''))}
      title={o ? t('{action} until…', { action: tMaybe(o.dateKind.actionLabel) }) : ''}
      description={o ? `${o.label} · ${o.assetName} · ${t('now {date}', { date: formatDate(o.dueDate) })}` : undefined}
      footer={
        <>
          <Button onClick={() => (onClose(), setUntil(''))}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!o || !value || value <= o.dueDate} onClick={() => (onRenew(value), setUntil(''))}>
            {o && tMaybe(o.dateKind.actionLabel)}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Input type="date" aria-label={t('New date')} min={o ? addDuration(o.dueDate, { amount: 1, unit: 'day' }) : undefined} value={value} onChange={(e) => setUntil(e.target.value)} />
        <p className="text-xs text-muted">{o?.recurring ? t('Set the date you actually got, e.g. a year and 10 days. Reminders and the next renewal follow it.') : t('This date has no fixed term: set the new one. Reminders and the next renewal follow it.')}</p>
      </div>
    </Dialog>
  );
}

function SnoozeDialog({ obligation, onClose, onSnooze }: { obligation: Obligation | null; onClose: () => void; onSnooze: (until: string) => void }) {
  const today = todayIso();
  const [custom, setCustom] = useState(addDuration(today, { amount: 3, unit: 'day' }));
  const presets = [
    { label: t('Tomorrow'), date: addDuration(today, { amount: 1, unit: 'day' }) },
    { label: plural(3, 'In {n} day', 'In {n} days'), date: addDuration(today, { amount: 3, unit: 'day' }) },
    { label: t('Next week'), date: addDuration(today, { amount: 7, unit: 'day' }) },
    { label: plural(2, 'In {n} week', 'In {n} weeks'), date: addDuration(today, { amount: 14, unit: 'day' }) },
  ];
  return (
    <Dialog open={!!obligation} onOpenChange={(o) => !o && onClose()} title={t('Snooze reminders')} description={obligation ? `${obligation.label} · ${obligation.assetName}` : undefined}>
      <div className="grid grid-cols-2 gap-2">
        {presets.map((p) => (
          <button key={p.label} type="button" onClick={() => onSnooze(p.date)} className="rounded-lg border border-border px-3 py-2.5 text-start transition-colors hover:border-border-strong hover:bg-surface-2">
            <div className="text-[13px] font-medium">{p.label}</div>
            <div className="text-xs text-muted">{formatDate(p.date)}</div>
          </button>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Input type="date" min={addDuration(today, { amount: 1, unit: 'day' })} value={custom} onChange={(e) => setCustom(e.target.value)} />
        <Button variant="primary" onClick={() => onSnooze(custom)}>
          {t('Snooze')}
        </Button>
      </div>
    </Dialog>
  );
}

/** Obligations as a list; used on the home screen, unit pages and inside an asset. */
export function ObligationList({
  items,
  showAsset = true,
  canEdit,
  answering,
  onAnsweringChange,
}: {
  items: Obligation[];
  showAsset?: boolean;
  canEdit: (o: Obligation) => boolean;
  /** Controlled "answer the renewal check" dialog (e.g. opened from an email link). */
  answering?: Obligation | null;
  onAnsweringChange?: (o: Obligation | null) => void;
}) {
  const actions = useObligationActions();
  const { typeById } = useLookups();
  const me = useMe().data;
  const { buyer, everywhere } = useIsBuyer();
  const [snoozing, setSnoozing] = useState<Obligation | null>(null);
  const [renewing, setRenewing] = useState<Obligation | null>(null);
  const [asking, setAsking] = useState<Obligation | null>(null);
  const [localAnswering, setLocalAnswering] = useState<Obligation | null>(null);
  const answer = answering !== undefined ? answering : localAnswering;
  const setAnswer = onAnsweringChange ?? setLocalAnswering;

  return (
    <>
      <ul className="divide-y divide-border">
        {items.map((o) => {
          const type = typeById.get(o.assetTypeId);
          const active = o.state === 'open' || o.state === 'snoozed';
          const mine = !!o.ownerId && o.ownerId === me?.userId;
          // Renewing buys it again: the purchase unit does it; others ask for it.
          const renews = o.recurring || needsNewDate(o);
          const editable = canEdit(o);
          return (
            <li key={o.id} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50">
              {showAsset && type && <TypeIcon icon={type.icon} color={type.color} size={30} />}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  {showAsset ? (
                    <Link to="/assets/$assetId" params={{ assetId: o.assetId }} className="line-clamp-2 font-medium [overflow-wrap:anywhere] hover:underline sm:truncate">
                      {o.assetName}
                    </Link>
                  ) : (
                    <span className="font-medium">{o.label}</span>
                  )}
                  {showAsset && (
                    <span className="hidden sm:contents">
                      <DateKindBadge kind={o.dateKind} />
                    </span>
                  )}
                </div>
                {/* Phones: a wrapping line with the essentials; wider screens: one line with everything. */}
                <div className={cn('mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted', showAsset && 'sm:flex-nowrap sm:whitespace-nowrap')}>
                  {showAsset && (
                    <span className="sm:hidden">
                      <DueBadge obligation={o} />
                    </span>
                  )}
                  {showAsset && <span className="truncate">{o.label}</span>}
                  {showAsset && <span className="text-subtle">·</span>}
                  <span className="tabular-nums">{formatDate(o.dueDate)}</span>
                  {showAsset && o.spend && (
                    <>
                      <span className="text-subtle">·</span>
                      <span className="tabular-nums">{formatMoney(o.spend.amount, o.spend.currency, true)}</span>
                    </>
                  )}
                  {showAsset && (
                    <span className="hidden items-center gap-1.5 sm:inline-flex">
                      <span className="text-subtle">·</span>
                      <UnitPath id={o.unitId} leafOnly />
                    </span>
                  )}
                  {showAsset && o.ownerId && (
                    <span className="ms-1 hidden sm:inline-flex">
                      <PersonName id={o.ownerId} />
                    </span>
                  )}
                  {!showAsset && <DueBadge obligation={o} />}
                  {!showAsset && <DateKindBadge kind={o.dateKind} />}
                  <CheckBadge check={o.check} mine={mine} />
                  {o.renewalRequest && (
                    <Link to="/requests/$requestId" params={{ requestId: o.renewalRequest.id }} className="inline-flex items-center gap-1 hover:opacity-80" title={t('Renewal request {number}', { number: o.renewalRequest.number })}>
                      <RequestStatusBadge status={{ label: `${o.renewalRequest.number} · ${tMaybe(o.renewalRequest.label)}`, color: o.renewalRequest.color }} />
                    </Link>
                  )}
                </div>
              </div>
              {showAsset && (
                <span className="hidden sm:contents">
                  <DueBadge obligation={o} />
                </span>
              )}
              {active && o.check?.status === 'asked' && o.ownerId === me?.userId && (
                <Button size="sm" variant="primary" icon={<CircleHelp className="size-3.5" />} onClick={() => setAnswer(o)}>
                  {t('Still needed?')}
                </Button>
              )}
              {editable && active && renews && !buyer && !o.renewalRequest && (
                <Button
                  size="sm"
                  variant={o.urgency === 'overdue' || o.urgency === 'due_soon' ? 'primary' : 'secondary'}
                  className={cn(o.urgency === 'later' && 'opacity-0 group-hover:opacity-100 focus:opacity-100 touch:opacity-100')}
                  icon={<ShoppingCart className="size-3.5" />}
                  title={t('Renewals are done by the unit responsible for purchases')}
                  onClick={() => actions.requestRenewal(o)}
                >
                  {t('Ask to renew')}
                </Button>
              )}
              {active && (renews ? buyer && (editable || everywhere) : editable) && (
                <Button
                  size="sm"
                  variant={o.urgency === 'overdue' || o.urgency === 'due_soon' ? 'primary' : 'secondary'}
                  className={cn(o.urgency === 'later' && 'opacity-0 group-hover:opacity-100 focus:opacity-100 touch:opacity-100')}
                  icon={o.recurring || needsNewDate(o) ? <RefreshCcw className="size-3.5" /> : <Check className="size-3.5" />}
                  disabled={actions.pending}
                  onClick={() => (needsNewDate(o) ? setRenewing(o) : actions.primary(o))}
                >
                  {tMaybe(o.dateKind.actionLabel)}
                </Button>
              )}
              {editable && (
                <Menu trigger={<Button size="icon" variant="ghost" aria-label={t('More actions')} icon={<MoreHorizontal className="size-4" />} />}>
                  {active ? (
                    <>
                      {mine ? (
                        // You own it: nobody to ask; answer it yourself.
                        <MenuItem icon={<CircleHelp />} onSelect={() => setAnswer(o)}>
                          {o.check && o.check.status !== 'asked' ? t('Change your answer…') : t('Still needed? Answer…')}
                        </MenuItem>
                      ) : (
                        <>
                          {o.ownerId && (
                            <MenuItem icon={<MessageCircleQuestion />} onSelect={() => setAsking(o)}>
                              {o.check?.status === 'asked' ? t('Ask the owner again…') : t('Ask the owner if still needed…')}
                            </MenuItem>
                          )}
                          <MenuItem icon={<CircleHelp />} onSelect={() => setAnswer(o)}>
                            {o.check && o.check.status !== 'asked' ? t('Change the answer…') : t('Answer for the owner…')}
                          </MenuItem>
                        </>
                      )}
                      {o.recurring && buyer && (
                        <MenuItem icon={<RefreshCcw />} onSelect={() => setRenewing(o)}>
                          {t('{action} until a date…', { action: tMaybe(o.dateKind.actionLabel) })}
                        </MenuItem>
                      )}
                      {!o.renewalRequest && (
                        <MenuItem icon={<ShoppingCart />} onSelect={() => actions.requestRenewal(o)}>
                          {t('Open a renewal request')}
                        </MenuItem>
                      )}
                      <MenuSeparator />
                      <MenuItem icon={<AlarmClock />} onSelect={() => setSnoozing(o)}>
                        {t('Snooze…')}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={<XCircle />} onSelect={() => actions.dismiss(o)}>
                        {t('Dismiss reminders')}
                      </MenuItem>
                    </>
                  ) : (
                    <MenuItem icon={<RotateCcw />} onSelect={() => actions.reopen(o)}>
                      {t('Reopen')}
                    </MenuItem>
                  )}
                </Menu>
              )}
            </li>
          );
        })}
      </ul>
      <AskOwnerDialog obligation={asking} onClose={() => setAsking(null)} />
      <AnswerDialog obligation={answer} onClose={() => setAnswer(null)} />
      <RenewUntilDialog
        obligation={renewing}
        onClose={() => setRenewing(null)}
        onRenew={(until) => {
          if (renewing) actions.renewUntil(renewing, until);
          setRenewing(null);
        }}
      />
      <SnoozeDialog
        obligation={snoozing}
        onClose={() => setSnoozing(null)}
        onSnooze={(until) => {
          if (snoozing) actions.snooze(snoozing, until);
          setSnoozing(null);
        }}
      />
    </>
  );
}
