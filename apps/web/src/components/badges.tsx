import { permissionMeta, roleOf, roles, type Permission, type AssetType, type Obligation, type RequestStatusInfo, type Urgency } from '@am/core';
import { Badge } from './ui/display';
import { t, tMaybe } from '@/lib/i18n';
import { relativeDays } from '@/lib/utils';

export function StatusBadge({ type, status }: { type: AssetType | undefined; status: string }) {
  const s = type?.statuses.find((x) => x.value === status);
  return <Badge color={s?.color ?? '#94a3b8'}>{tMaybe(s?.label ?? status)}</Badge>;
}

export function DateKindBadge({ kind }: { kind: { name: string; color: string } }) {
  return <Badge color={kind.color}>{tMaybe(kind.name)}</Badge>;
}

const urgencyTone: Record<Urgency, 'danger' | 'warning' | 'accent' | 'neutral'> = { overdue: 'danger', due_soon: 'warning', upcoming: 'accent', later: 'neutral' };

export function DueBadge({ obligation }: { obligation: Pick<Obligation, 'urgency' | 'dueDate' | 'state' | 'snoozedUntil'> }) {
  if (obligation.state === 'done') return <Badge tone="success">{t('Done')}</Badge>;
  if (obligation.state === 'dismissed') return <Badge>{t('Dismissed')}</Badge>;
  if (obligation.state === 'snoozed' && obligation.snoozedUntil) return <Badge>{t('Snoozed · {when}', { when: relativeDays(obligation.snoozedUntil) })}</Badge>;
  return <Badge tone={urgencyTone[obligation.urgency]}>{relativeDays(obligation.dueDate)}</Badge>;
}

/** "You: Editor" — hover lists exactly what the caller may do. */
export function AccessBadge({ permissions }: { permissions: readonly Permission[] }) {
  const role = roleOf(permissions);
  return (
    <span title={t('You can: {permissions}', { permissions: permissions.map((p) => tMaybe(permissionMeta[p].label).toLowerCase()).join(', ') })}>
      <Badge tone={role === 'admin' ? 'accent' : 'neutral'}>{role === 'custom' ? t('Custom access') : tMaybe(roles[role].label)}</Badge>
    </span>
  );
}

/** A status of a request's workflow, in its own colour. */
export function RequestStatusBadge({ status }: { status: Pick<RequestStatusInfo, 'label' | 'color'> }) {
  return <Badge color={status.color}>{tMaybe(status.label)}</Badge>;
}
