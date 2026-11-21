import { renewalDecisionMeta, type Obligation, type RenewalDecision } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleHelp, PencilLine, RefreshCcw, XCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { keys } from '@/lib/queries';
import { cn, formatDate, formatDateTime } from '@/lib/utils';
import { t, tMaybe } from '@/lib/i18n';
import { tj } from '@/lib/i18n-react';
import { PersonName } from './pickers';
import { Button } from './ui/button';
import { Badge } from './ui/display';
import { Textarea } from './ui/form';
import { Dialog } from './ui/overlay';

/** "Waiting for owner" / "Owner: renew" … next to a date. */
export function CheckBadge({ check, mine = false }: { check: Obligation['check']; /** The viewer owns the item: it is waiting on them. */ mine?: boolean }) {
  if (!check) return null;
  const meta = renewalDecisionMeta[check.status];
  if (mine && check.status === 'asked') return <Badge tone={meta.tone}>{t('Waiting for your answer')}</Badge>;
  const detail =
    check.status === 'asked'
      ? t(check.message ? 'Asked by {name}: {message}' : 'Asked by {name}', { name: check.askedByName ?? t('someone'), message: check.message })
      : `${check.answeredByName ?? t('Owner')}${check.note ? `: ${check.note}` : ''}`;
  return (
    <span title={detail}>
      <Badge tone={meta.tone}>{tMaybe(meta.label)}</Badge>
    </span>
  );
}

const answeredLabel: Record<RenewalDecision, string> = { renew: t('Answered: renew'), change: t('Answered: renew with changes'), cancel: t('Answered: don’t renew') };

export function useCheckActions() {
  const qc = useQueryClient();
  const done = (o: Obligation) => {
    void qc.invalidateQueries({ queryKey: keys.obligations });
    // The question and the answer are also posted to the asset's conversation (asynchronously).
    setTimeout(() => void qc.invalidateQueries({ queryKey: keys.comments(o.assetId) }), 1500);
  };
  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('Something went wrong'));
  const ask = useMutation({
    mutationFn: ({ o, message }: { o: Obligation; message: string }) => api.post(`/api/scheduler/obligations/${o.id}/actions`, { action: 'ask', message: message || undefined }),
    onSuccess: (_d, { o }) => {
      toast.success(t('Owner asked'), { description: t('They’ll get an email and see it in Upcoming. Answers show up here and in the conversation about {asset}.', { asset: o.assetName }) });
      done(o);
    },
    onError,
  });
  const answer = useMutation({
    mutationFn: ({ o, decision, note }: { o: Obligation; decision: RenewalDecision; note: string }) => api.post(`/api/scheduler/obligations/${o.id}/actions`, { action: 'answer', decision, note: note || undefined }),
    onSuccess: (_d, { o, decision }) => {
      toast.success(answeredLabel[decision], { description: o.assetName });
      done(o);
    },
    onError,
  });
  return { ask, answer };
}

export function AskOwnerDialog({ obligation, onClose }: { obligation: Obligation | null; onClose: () => void }) {
  const { ask } = useCheckActions();
  const [message, setMessage] = useState('');
  useEffect(() => setMessage(''), [obligation?.id]);
  if (!obligation) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('Ask the owner')}
      description={`${obligation.assetName} · ${tMaybe(obligation.label)} ${formatDate(obligation.dueDate)}`}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={ask.isPending} onClick={() => ask.mutate({ o: obligation, message }, { onSuccess: onClose })}>
            {t('Ask')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p className="text-muted">
          {obligation.ownerId ? (
            tj('{person} will be asked whether to renew as is, renew with changes, or not renew.', { person: <PersonName id={obligation.ownerId} /> })
          ) : (
            t('Nobody owns this, so the managers of its team will be asked whether to renew it.')
          )}
        </p>
        <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('Optional: add context, e.g. “The vendor raised the price 12%. Still need 40 seats?”')} />
      </div>
    </Dialog>
  );
}

const choices: Array<{ value: RenewalDecision; title: string; hint: string; icon: ReactNode; tone: string }> = [
  { value: 'renew', title: t('Renew as is'), hint: t('Still needed, nothing changes'), icon: <RefreshCcw className="size-4" />, tone: 'text-success' },
  { value: 'change', title: t('Renew with changes'), hint: t('More or fewer seats, another plan…'), icon: <PencilLine className="size-4" />, tone: 'text-accent' },
  { value: 'cancel', title: t('Don’t renew'), hint: t('No longer needed'), icon: <XCircle className="size-4" />, tone: 'text-danger' },
];

/** The owner's side: one click, with an optional note. */
export function AnswerDialog({ obligation, initial, onClose }: { obligation: Obligation | null; initial?: RenewalDecision; onClose: () => void }) {
  const { answer } = useCheckActions();
  const [decision, setDecision] = useState<RenewalDecision | null>(initial ?? null);
  const [note, setNote] = useState('');
  useEffect(() => {
    setDecision(initial ?? null);
    setNote('');
  }, [obligation?.id, initial]);
  if (!obligation) return null;
  const check = obligation.check;
  const needsNote = decision === 'change';
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('Should we renew {name}?', { name: obligation.assetName })}
      description={`${tMaybe(obligation.label)} ${formatDate(obligation.dueDate)}`}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!decision || (needsNote && !note.trim())} loading={answer.isPending} onClick={() => decision && answer.mutate({ o: obligation, decision, note }, { onSuccess: onClose })}>
            {t('Send answer')}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[13px]">
        {check?.status === 'asked' && (
          <div className="flex gap-2 rounded-lg bg-surface-2 px-3 py-2.5">
            <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted" />
            <div>
              <p>
                <span className="font-medium">{check.askedByName}</span> <span className="text-muted">{check.askedAt ? t('asked {when}', { when: formatDateTime(check.askedAt) }) : t('asked')}</span>
              </p>
              {check.message && <p className="mt-1 whitespace-pre-wrap">{check.message}</p>}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {choices.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setDecision(c.value)}
              aria-pressed={decision === c.value}
              className={cn('rounded-lg border px-3 py-3 text-start transition-colors hover:border-border-strong', decision === c.value ? 'border-accent bg-accent-soft' : 'border-border')}
            >
              <span className={cn('flex items-center gap-1.5 font-medium', c.tone)}>
                {c.icon}
                {c.title}
              </span>
              <span className="mt-1 block text-xs text-muted">{c.hint}</span>
            </button>
          ))}
        </div>
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={decision === 'change' ? t('What should change? e.g. “Drop to 25 seats, move to the Business plan”') : decision === 'cancel' ? t('Optional: why, or what replaces it') : t('Optional note for the buyer')}
        />
      </div>
    </Dialog>
  );
}
