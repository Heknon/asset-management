import type { AccessLevel, AssetType, Obligation, Urgency } from '@am/core';
import { Badge } from './ui/display';
import { relativeDays } from '@/lib/utils';

export function StatusBadge({ type, status }: { type: AssetType | undefined; status: string }) {
  const s = type?.statuses.find((x) => x.value === status);
  return <Badge color={s?.color ?? '#94a3b8'}>{s?.label ?? status}</Badge>;
}

export function DateKindBadge({ kind }: { kind: { name: string; color: string } }) {
  return <Badge color={kind.color}>{kind.name}</Badge>;
}

const urgencyTone: Record<Urgency, 'danger' | 'warning' | 'accent' | 'neutral'> = { overdue: 'danger', due_soon: 'warning', upcoming: 'accent', later: 'neutral' };

export function DueBadge({ obligation }: { obligation: Pick<Obligation, 'urgency' | 'dueDate' | 'state' | 'snoozedUntil'> }) {
  if (obligation.state === 'done') return <Badge tone="success">Done</Badge>;
  if (obligation.state === 'dismissed') return <Badge>Dismissed</Badge>;
  if (obligation.state === 'snoozed' && obligation.snoozedUntil) return <Badge>Snoozed · {relativeDays(obligation.snoozedUntil)}</Badge>;
  return <Badge tone={urgencyTone[obligation.urgency]}>{relativeDays(obligation.dueDate)}</Badge>;
}

export function AccessBadge({ level }: { level: AccessLevel }) {
  const label = { none: 'No access', view: 'Viewer', edit: 'Editor', manage: 'Manager' }[level];
  return <Badge tone={level === 'manage' ? 'accent' : 'neutral'}>{label}</Badge>;
}
