import type { UserSummary } from '@am/core';
import { Command } from 'cmdk';
import { Building2, Check, ChevronRight, ChevronsUpDown, X } from 'lucide-react';
import { useState } from 'react';
import type { OrgUnit } from '@am/core';
import { useLookups, usePeople, usePeopleSearch, useAssetTypes } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Avatar } from './ui/display';
import { Select } from './ui/form';
import { Popover } from './ui/overlay';
import { typeIcons } from './type-icon';

const triggerClass =
  'flex h-8 w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-left text-[13px] transition-colors hover:border-border-strong focus:border-accent focus:outline-none';

/** Searchable picker for a directory person. */
export function PersonPicker({ value, onChange, id, placeholder = 'Select a person', allowClear = true }: { value: string | null; onChange: (id: string | null) => void; id?: string; placeholder?: string; allowClear?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const people = usePeopleSearch(q);
  const selected = usePeople([value]).get(value ?? '');
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[var(--radix-popover-trigger-width)] min-w-64"
      trigger={
        <button id={id} type="button" className={triggerClass}>
          {selected ? (
            <>
              <Avatar name={selected.displayName} size={18} />
              <span className="truncate">{selected.displayName}</span>
            </>
          ) : (
            <span className="text-subtle">{value ? 'Loading…' : placeholder}</span>
          )}
          <span className="ml-auto flex items-center gap-1 text-subtle">
            {allowClear && value && (
              <X
                className="size-3.5 hover:text-fg"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
              />
            )}
            <ChevronsUpDown className="size-3.5" />
          </span>
        </button>
      }
    >
      <Command shouldFilter={false} className="flex flex-col">
        <Command.Input value={q} onValueChange={setQ} placeholder="Search people…" className="h-9 border-b border-border bg-transparent px-3 text-[13px] outline-none placeholder:text-subtle" />
        <Command.List className="max-h-64 overflow-y-auto p-1">
          <Command.Empty className="px-3 py-6 text-center text-xs text-muted">No people found</Command.Empty>
          {(people.data ?? []).map((p: UserSummary) => (
            <Command.Item
              key={p.id}
              value={p.id}
              onSelect={() => {
                onChange(p.id);
                setOpen(false);
              }}
              className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] data-[selected=true]:bg-surface-2"
            >
              <Avatar name={p.displayName} size={20} />
              <span className="min-w-0 flex-1 truncate">
                {p.displayName}
                <span className="ml-1.5 text-xs text-subtle">{p.email ?? p.username}</span>
              </span>
              {value === p.id && <Check className="size-3.5 text-accent" />}
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </Popover>
  );
}

export function PersonName({ id, fallback = '—' }: { id: string | null | undefined; fallback?: string }) {
  const p = usePeople([id]).get(id ?? '');
  if (!id) return <span className="text-subtle">{fallback}</span>;
  // Still loading: a quiet placeholder of about a name's size, not "?" and "…".
  if (!p)
    return (
      <span className="inline-flex items-center gap-1.5" aria-busy="true">
        <span className="size-[18px] animate-pulse rounded-full bg-surface-3" />
        <span className="h-2.5 w-20 animate-pulse rounded bg-surface-3" />
      </span>
    );
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar name={p.displayName} size={18} />
      <span className="truncate">{p.displayName}</span>
    </span>
  );
}

/** "Wix › R&D › Editor" — the unit with its ancestors, shortest form that fits. */
export function UnitPath({ id, className, leafOnly }: { id: string | null | undefined; className?: string; leafOnly?: boolean }) {
  const { unitPathNames, unitById } = useLookups();
  const names = unitPathNames(id);
  if (!names.length) return <span className="text-subtle">—</span>;
  const unit = id ? unitById.get(id) : undefined;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)} title={names.join(' › ')}>
      {unit && <span className="size-1.5 shrink-0 rounded-full" style={{ background: unit.color }} />}
      {!leafOnly && names.length > 1 && <span className="truncate text-subtle">{names.slice(Math.max(0, names.length - 3), -1).join(' › ')} ›</span>}
      <span className="truncate">{names[names.length - 1]}</span>
    </span>
  );
}

export interface UnitOption {
  unit: OrgUnit;
  /** Optional hint shown on the right, e.g. "Your team". */
  hint?: string;
}

/**
 * Searchable picker over the organization tree. Typing matches any level of
 * the path, so "editor plat" finds Wix › R&D › Editor › Platform.
 */
export function UnitPicker({
  value,
  onChange,
  id,
  placeholder = 'Choose a team',
  allowClear = false,
  clearLabel = 'Whole organization',
  suggested,
  filter,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  id?: string;
  placeholder?: string;
  allowClear?: boolean;
  clearLabel?: string;
  /** Shown first, e.g. the person's own team and the units above it. */
  suggested?: UnitOption[];
  filter?: (u: OrgUnit) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const { units, unitPathNames } = useLookups();
  const label = (u: OrgUnit) => unitPathNames(u.id).join(' › ');
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = units
    .filter((u) => !u.archived && (!filter || filter(u)))
    .filter((u) => terms.every((t) => label(u).toLowerCase().includes(t)))
    .slice(0, 60);
  const select = (v: string | null) => {
    onChange(v);
    setOpen(false);
    setQ('');
  };
  const item = 'flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] data-[selected=true]:bg-surface-2';
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[var(--radix-popover-trigger-width)] min-w-80"
      trigger={
        <button id={id} type="button" className={triggerClass}>
          {value ? <UnitPath id={value} /> : <span className="text-subtle">{allowClear ? clearLabel : placeholder}</span>}
          <span className="ml-auto flex items-center gap-1 text-subtle">
            {allowClear && value && (
              <X
                className="size-3.5 hover:text-fg"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
              />
            )}
            <ChevronsUpDown className="size-3.5" />
          </span>
        </button>
      }
    >
      <Command shouldFilter={false} className="flex flex-col">
        <Command.Input value={q} onValueChange={setQ} placeholder="Search teams, departments, divisions…" className="h-9 border-b border-border bg-transparent px-3 text-[13px] outline-none placeholder:text-subtle" />
        <Command.List className="max-h-80 overflow-y-auto p-1">
          <Command.Empty className="px-3 py-6 text-center text-xs text-muted">No matching units</Command.Empty>
          {!q && suggested && suggested.length > 0 && (
            <Command.Group heading="Suggested" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-subtle">
              {suggested.map(({ unit, hint }) => (
                <Command.Item key={`s-${unit.id}`} value={`s-${unit.id}`} onSelect={() => select(unit.id)} className={item}>
                  <Building2 className="size-3.5 shrink-0 text-subtle" />
                  <span className="min-w-0 flex-1 truncate font-medium">{unit.name}</span>
                  {hint && <span className="text-xs text-subtle">{hint}</span>}
                  {value === unit.id && <Check className="size-3.5 text-accent" />}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {allowClear && !q && (
            <Command.Item value="__all" onSelect={() => select(null)} className={item}>
              <Building2 className="size-3.5 text-subtle" />
              <span className="flex-1">{clearLabel}</span>
              {!value && <Check className="size-3.5 text-accent" />}
            </Command.Item>
          )}
          {matches.map((u) => {
            const names = unitPathNames(u.id);
            return (
              <Command.Item key={u.id} value={u.id} onSelect={() => select(u.id)} className={item}>
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: u.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{u.name}</span>
                  {names.length > 1 && (
                    <span className="flex items-center gap-0.5 truncate text-[11px] text-subtle">
                      {names.slice(0, -1).map((n, i) => (
                        <span key={i} className="inline-flex items-center gap-0.5">
                          {i > 0 && <ChevronRight className="size-2.5" />}
                          {n}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-subtle">{u.kind}</span>
                {value === u.id && <Check className="size-3.5 text-accent" />}
              </Command.Item>
            );
          })}
        </Command.List>
      </Command>
    </Popover>
  );
}

export function AssetTypeSelect({ value, onChange, id, includeAll, allLabel = 'All asset types' }: { value: string | null; onChange: (v: string | null) => void; id?: string; includeAll?: boolean; allLabel?: string }) {
  const types = useAssetTypes();
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {includeAll ? <option value="">{allLabel}</option> : <option value="" disabled>Select an asset type</option>}
      {(types.data ?? []).map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </Select>
  );
}

const palette = ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b', '#10b981', '#14b8a6', '#0ea5e9', '#64748b'];

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {palette.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn('size-6 rounded-full ring-offset-2 ring-offset-surface transition', value === c ? 'ring-2' : 'hover:scale-110')}
          style={{ background: c, ['--tw-ring-color' as string]: c }}
        />
      ))}
    </div>
  );
}

export function IconPicker({ value, onChange, color }: { value: string; onChange: (i: string) => void; color: string }) {
  return (
    <div className="grid grid-cols-11 gap-1">
      {Object.entries(typeIcons).map(([name, Icon]) => (
        <button
          key={name}
          type="button"
          aria-label={name}
          onClick={() => onChange(name)}
          className={cn('flex size-7 items-center justify-center rounded-md transition-colors', value === name ? 'bg-surface-3' : 'text-muted hover:bg-surface-2')}
          style={value === name ? { color } : undefined}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}
