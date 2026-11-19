import { permissionMeta, roleOf, roles, requestStatusMeta, type Permission, type AssetType, type Obligation, type RequestStatus, type Urgency } from '@am/core';
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

/** "You: Editor" — hover lists exactly what the caller may do. */
export function AccessBadge({ permissions }: { permissions: readonly Permission[] }) {
  const role = roleOf(permissions);
  return (
    <span title={`You can: ${permissions.map((p) => permissionMeta[p].label.toLowerCase()).join(', ')}`}>
      <Badge tone={role === 'admin' ? 'accent' : 'neutral'}>{role === 'custom' ? 'Custom access' : roles[role].label}</Badge>
    </span>
  );
}

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const m = requestStatusMeta[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
