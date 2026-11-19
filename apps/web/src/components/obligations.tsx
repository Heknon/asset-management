import { addDuration, type Obligation } from '@am/core';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { AlarmClock, Check, CircleHelp, ShoppingCart, MessageCircleQuestion, MoreHorizontal, RefreshCcw, RotateCcw, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useInvalidateAssets, useLookups, useMe } from '@/lib/queries';
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
  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Something went wrong');

  const advance = useMutation({
    mutationFn: (o: Obligation) => api.post(`/api/registry/assets/${o.assetId}/dates/${o.fieldKey}/advance`),
    onSuccess: (_d, o) => {
      toast.success(`${o.dateKind.actionLabel}: ${o.assetName}`, { description: `${o.label} rolled forward` });
      invalidate(o.assetId);
    },
    onError,
  });
  const act = useMutation({
    mutationFn: ({ o, body }: { o: Obligation; body: Record<string, unknown> }) => api.post(`/api/scheduler/obligations/${o.id}/actions`, body),
    onSuccess: (_d, { o, body }) => {
      toast.success(body.action === 'snooze' ? `Snoozed until ${formatDate(body.until as string)}` : body.action === 'reopen' ? 'Reopened' : body.action === 'dismiss' ? 'Dismissed' : 'Marked complete');
      invalidate(o.assetId);
    },
    onError,
  });

  const navigate = useNavigate();
  const renewal = useMutation({
    mutationFn: (o: Obligation) => api.post<{ id: string; number: string }>(`/api/registry/assets/${o.assetId}/renewal-requests`, { fieldKey: o.fieldKey, obligationId: o.id }),
    onSuccess: (r, o) => {
      toast.success(`${r.number} opened`, { description: `Renewal of ${o.assetName}` });
      invalidate(o.assetId);
      void navigate({ to: '/requests/$requestId', params: { requestId: r.id } });
    },
    onError,
  });

  return {
    requestRenewal: (o: Obligation) => renewal.mutate(o),
    primary: (o: Obligation) => (o.recurring ? advance.mutate(o) : act.mutate({ o, body: { action: 'complete' } })),
    snooze: (o: Obligation, until: string) => act.mutate({ o, body: { action: 'snooze', until } }),
    dismiss: (o: Obligation) => act.mutate({ o, body: { action: 'dismiss' } }),
    reopen: (o: Obligation) => act.mutate({ o, body: { action: 'reopen' } }),
    pending: advance.isPending || act.isPending,
  };
}

function SnoozeDialog({ obligation, onClose, onSnooze }: { obligation: Obligation | null; onClose: () => void; onSnooze: (until: string) => void }) {
  const today = todayIso();
  const [custom, setCustom] = useState(addDuration(today, { amount: 3, unit: 'day' }));
  const presets = [
    { label: 'Tomorrow', date: addDuration(today, { amount: 1, unit: 'day' }) },
    { label: 'In 3 days', date: addDuration(today, { amount: 3, unit: 'day' }) },
    { label: 'Next week', date: addDuration(today, { amount: 7, unit: 'day' }) },
    { label: 'In 2 weeks', date: addDuration(today, { amount: 14, unit: 'day' }) },
  ];
  return (
    <Dialog open={!!obligation} onOpenChange={(o) => !o && onClose()} title="Snooze reminders" description={obligation ? `${obligation.label} · ${obligation.assetName}` : undefined}>
      <div className="grid grid-cols-2 gap-2">
        {presets.map((p) => (
          <button key={p.label} type="button" onClick={() => onSnooze(p.date)} className="rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-2">
            <div className="text-[13px] font-medium">{p.label}</div>
            <div className="text-xs text-muted">{formatDate(p.date)}</div>
          </button>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Input type="date" min={addDuration(today, { amount: 1, unit: 'day' })} value={custom} onChange={(e) => setCustom(e.target.value)} />
        <Button variant="primary" onClick={() => onSnooze(custom)}>
          Snooze
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
  const [snoozing, setSnoozing] = useState<Obligation | null>(null);
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
          const editable = canEdit(o);
          return (
            <li key={o.id} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50">
              {showAsset && type && <TypeIcon icon={type.icon} color={type.color} size={30} />}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  {showAsset ? (
                    <Link to="/assets/$assetId" params={{ assetId: o.assetId }} className="truncate font-medium hover:underline">
                      {o.assetName}
                    </Link>
                  ) : (
                    <span className="font-medium">{o.label}</span>
                  )}
                  {showAsset && <DateKindBadge kind={o.dateKind} />}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted">
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
                    <>
                      <span className="text-subtle">·</span>
                      <UnitPath id={o.unitId} leafOnly />
                    </>
                  )}
                  {showAsset && o.ownerId && (
                    <span className="ml-1 hidden sm:inline-flex">
                      <PersonName id={o.ownerId} />
                    </span>
                  )}
                  {!showAsset && <DueBadge obligation={o} />}
                  {!showAsset && <DateKindBadge kind={o.dateKind} />}
                  <CheckBadge check={o.check} />
                  {o.renewalRequest && (
                    <Link to="/requests/$requestId" params={{ requestId: o.renewalRequest.id }} className="inline-flex items-center gap-1 hover:opacity-80" title={`Renewal request ${o.renewalRequest.number}`}>
                      <RequestStatusBadge status={{ label: `${o.renewalRequest.number} · ${o.renewalRequest.label}`, color: o.renewalRequest.color }} />
                    </Link>
                  )}
                </div>
              </div>
              {showAsset && <DueBadge obligation={o} />}
              {active && o.check?.status === 'asked' && o.ownerId === me?.userId && (
                <Button size="sm" variant="primary" icon={<CircleHelp className="size-3.5" />} onClick={() => setAnswer(o)}>
                  Still needed?
                </Button>
              )}
              {editable && active && (
                <Button
                  size="sm"
                  variant={o.urgency === 'overdue' || o.urgency === 'due_soon' ? 'primary' : 'secondary'}
                  className={cn(o.urgency === 'later' && 'opacity-0 group-hover:opacity-100 focus:opacity-100')}
                  icon={o.recurring ? <RefreshCcw className="size-3.5" /> : <Check className="size-3.5" />}
                  disabled={actions.pending}
                  onClick={() => actions.primary(o)}
                >
                  {o.dateKind.actionLabel}
                </Button>
              )}
              {editable && (
                <Menu trigger={<Button size="icon" variant="ghost" aria-label="More actions" icon={<MoreHorizontal className="size-4" />} />}>
                  {active ? (
                    <>
                      <MenuItem icon={<MessageCircleQuestion />} onSelect={() => setAsking(o)}>
                        {o.check?.status === 'asked' ? 'Ask the owner again…' : 'Ask the owner if still needed…'}
                      </MenuItem>
                      <MenuItem icon={<CircleHelp />} onSelect={() => setAnswer(o)}>
                        {o.check && o.check.status !== 'asked' ? 'Change the answer…' : 'Answer for the owner…'}
                      </MenuItem>
                      {!o.renewalRequest && (
                        <MenuItem icon={<ShoppingCart />} onSelect={() => actions.requestRenewal(o)}>
                          Open a renewal request
                        </MenuItem>
                      )}
                      <MenuSeparator />
                      <MenuItem icon={<AlarmClock />} onSelect={() => setSnoozing(o)}>
                        Snooze…
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={<XCircle />} onSelect={() => actions.dismiss(o)}>
                        Dismiss reminders
                      </MenuItem>
                    </>
                  ) : (
                    <MenuItem icon={<RotateCcw />} onSelect={() => actions.reopen(o)}>
                      Reopen
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
