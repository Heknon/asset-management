import {
  normalizePermissions,
  permissionGroups,
  permissionKeys,
  permissionMeta,
  roleKeys,
  roleOf,
  roles,
  type Permission,
  type Subject,
  type SubjectKind,
} from '@am/core';
import { useQuery } from '@tanstack/react-query';
import { Building2, Check, ChevronDown, Search, Trash2, User, Users, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { AssetTypeSelect } from './pickers';
import { Button } from './ui/button';
import { Badge } from './ui/display';
import { Checkbox, Input } from './ui/form';
import { Popover } from './ui/overlay';

/** "Editor", or "Custom · 4 permissions". */
export function accessLabel(perms: readonly Permission[]): string {
  const role = roleOf(perms);
  return role === 'custom' ? `Custom · ${perms.length} permissions` : roles[role].label;
}

export function SubjectIcon({ kind, className }: { kind: SubjectKind; className?: string }) {
  const Icon = kind === 'user' ? User : kind === 'group' ? Users : Building2;
  return (
    <span className={cn('flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted', className)}>
      <Icon className="size-4" />
    </span>
  );
}

/**
 * Pick a role — or open "Custom" and tick exactly what is allowed. The list
 * reads like a sentence of what someone can do, so nobody needs to know the
 * permission names.
 */
export function RoleSelect({ value, onChange, disabled, compact }: { value: Permission[]; onChange: (p: Permission[]) => void; disabled?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const role = roleOf(value);
  const [custom, setCustom] = useState(role === 'custom');
  const toggle = (p: Permission, on: boolean) => onChange(normalizePermissions(on ? [...value, p] : value.filter((x) => x !== p)));

  return (
    <Popover
      open={open}
      onOpenChange={(o) => (setOpen(o), o && setCustom(role === 'custom'))}
      align="end"
      className="max-h-[70vh] w-80 overflow-y-auto p-1.5"
      trigger={
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'inline-flex items-center justify-between gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[13px] whitespace-nowrap transition-colors hover:border-border-strong disabled:opacity-60',
            compact ? 'h-8 min-w-28' : 'h-9 min-w-36',
          )}
        >
          {accessLabel(value)}
          <ChevronDown className="size-3.5 text-subtle" />
        </button>
      }
    >
      <ul role="listbox" aria-label="Role">
        {roleKeys.map((r) => (
          <li key={r}>
            <button
              type="button"
              role="option"
              aria-selected={role === r}
              onClick={() => (onChange([...roles[r].permissions]), setCustom(false), setOpen(false))}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start hover:bg-surface-2"
            >
              <Check className={cn('mt-0.5 size-3.5 shrink-0', role === r ? 'text-accent' : 'text-transparent')} />
              <span>
                <span className="block text-[13px] font-medium">{roles[r].label}</span>
                <span className="block text-xs text-muted">{roles[r].description}</span>
              </span>
            </button>
          </li>
        ))}
        <li className="mt-1 border-t border-border pt-1">
          <button type="button" onClick={() => setCustom((c) => !c)} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start hover:bg-surface-2">
            <Check className={cn('mt-0.5 size-3.5 shrink-0', role === 'custom' ? 'text-accent' : 'text-transparent')} />
            <span>
              <span className="block text-[13px] font-medium">Custom…</span>
              <span className="block text-xs text-muted">Choose exactly what they can do</span>
            </span>
          </button>
        </li>
      </ul>
      {custom && (
        <div className="mt-1 space-y-2.5 border-t border-border px-2 pt-2 pb-1">
          {permissionGroups.map((g) => (
            <div key={g}>
              <p className="mb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">{g}</p>
              {permissionKeys
                .filter((p) => permissionMeta[p].group === g)
                .map((p) => (
                  <div key={p} className="py-0.5" title={permissionMeta[p].description}>
                    <Checkbox
                      checked={value.includes(p)}
                      disabled={p === 'view'}
                      onChange={(on) => toggle(p, on)}
                      label={
                        <span>
                          <span className="text-[13px]">{permissionMeta[p].label}</span>
                          <span className="block text-xs text-muted">{permissionMeta[p].description}</span>
                        </span>
                      }
                    />
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** Search people, organization units and directory groups in one box. */
export function SubjectPicker({ value, onChange, kinds = ['user', 'unit', 'group'], exclude = [] }: { value: Subject | null; onChange: (s: Subject | null) => void; kinds?: SubjectKind[]; exclude?: string[] }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const term = useDebounced(q.trim(), 150);
  const results = useQuery({
    queryKey: ['subjects', term, kinds.join(',')],
    queryFn: () => api.get<Subject[]>('/api/identity/subjects', { q: term, kinds: kinds.join(',') }),
    enabled: term.length > 0,
    staleTime: 30_000,
  });
  const items = (results.data ?? []).filter((s) => !exclude.includes(`${s.kind}:${s.id}`));

  if (value) {
    return (
      <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-2">
        <SubjectIcon kind={value.kind} className="size-6" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{value.name}</span>
        <button type="button" aria-label="Clear" className="text-subtle hover:text-fg" onClick={() => onChange(null)}>
          <X className="size-3.5" />
        </button>
      </div>
    );
  }
  return (
    <div className="relative min-w-0 flex-1 basis-full sm:basis-0">
      <Search className="pointer-events-none absolute top-1/2 start-2.5 size-3.5 -translate-y-1/2 text-subtle" />
      <Input
        className="ps-8"
        value={q}
        placeholder={kinds.length === 3 ? 'Add people, teams or groups…' : 'Search…'}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label="Who"
      />
      {open && term && (
        <ul role="listbox" className="absolute top-full end-0 start-0 z-30 mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg">
          {items.length ? (
            items.map((s) => (
              <li key={`${s.kind}:${s.id}`}>
                <button type="button" role="option" aria-selected={false} onMouseDown={(e) => (e.preventDefault(), onChange(s), setQ(''))} className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-start hover:bg-surface-2">
                  <SubjectIcon kind={s.kind} className="size-6" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{s.name}</span>
                    <span className="block truncate text-xs text-muted">{s.detail}</span>
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-xs text-muted">{results.isFetching ? 'Searching…' : 'No people, teams or groups match'}</li>
          )}
        </ul>
      )}
    </div>
  );
}

export interface AccessEntry {
  key: string;
  subject: Subject;
  permissions: Permission[];
  /** E.g. "Only Software licenses", "Shared by Rachel Amar". */
  note?: ReactNode;
}

/**
 * The one screen for "who can do what here": add people, units or groups with
 * a role, change roles, remove. Used for units, the whole organization and
 * catalogs. Read-only rows (inherited access) are passed as `inherited`.
 */
export function AccessEditor({
  entries,
  inherited,
  canManage,
  onAdd,
  onChange,
  onRemove,
  allowTypeLimit,
  pending,
}: {
  entries: AccessEntry[];
  inherited?: ReactNode;
  canManage: boolean;
  onAdd: (subject: Subject, permissions: Permission[], assetTypeId: string | null) => void;
  onChange: (entry: AccessEntry, permissions: Permission[]) => void;
  onRemove: (entry: AccessEntry) => void;
  /** Units: optionally only for one asset type. */
  allowTypeLimit?: boolean;
  pending?: boolean;
}) {
  const [subject, setSubject] = useState<Subject | null>(null);
  const [perms, setPerms] = useState<Permission[]>([...roles.viewer.permissions]);
  const [typeLimit, setTypeLimit] = useState<string | null>(null);
  const [limiting, setLimiting] = useState(false);

  return (
    <div className="space-y-4 text-[13px]">
      {canManage && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <SubjectPicker value={subject} onChange={setSubject} exclude={entries.map((e) => e.key)} />
            <RoleSelect value={perms} onChange={setPerms} />
            <Button
              variant="primary"
              disabled={!subject}
              loading={pending}
              onClick={() => {
                if (!subject) return;
                onAdd(subject, perms, limiting ? typeLimit : null);
                setSubject(null);
              }}
            >
              Add
            </Button>
          </div>
          {allowTypeLimit &&
            (limiting ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">Only for</span>
                <div className="w-56">
                  <AssetTypeSelect value={typeLimit} onChange={setTypeLimit} includeAll allLabel="Every type" />
                </div>
              </div>
            ) : (
              <button type="button" className="text-xs text-accent-fg hover:underline" onClick={() => setLimiting(true)}>
                Limit to one kind of item…
              </button>
            ))}
          <p className="text-xs text-muted">Units include everyone in them and in the units beneath. Directory groups follow LDAP / ADFS membership.</p>
        </div>
      )}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {entries.map((e) => (
          <li key={e.key} className="flex items-center gap-2.5 px-3 py-2">
            <SubjectIcon kind={e.subject.kind} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{e.subject.name}</span>
              <span className="block truncate text-xs text-muted">
                {e.subject.detail}
                {e.note && <> · {e.note}</>}
              </span>
            </span>
            {canManage ? (
              <>
                <RoleSelect compact value={e.permissions} onChange={(p) => onChange(e, p)} />
                <Button size="icon" variant="ghost" aria-label={`Remove ${e.subject.name}`} icon={<Trash2 className="size-3.5" />} onClick={() => onRemove(e)} />
              </>
            ) : (
              <Badge>{accessLabel(e.permissions)}</Badge>
            )}
          </li>
        ))}
        {!entries.length && <li className="px-3 py-4 text-center text-xs text-muted">Nobody has been added here yet.</li>}
      </ul>
      {inherited}
    </div>
  );
}

/** Small list of what someone may do, for "What can I do here?" hints. */
export function PermissionSummary({ permissions }: { permissions: readonly Permission[] }) {
  return (
    <ul className="flex flex-wrap gap-1">
      {permissions.map((p) => (
        <li key={p}>
          <Badge>{permissionMeta[p].label}</Badge>
        </li>
      ))}
    </ul>
  );
}
