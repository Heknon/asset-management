import type { UserSummary } from '@am/core';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useState } from 'react';
import { usePeople, usePeopleSearch, usePurchaseClasses, useAssetTypes } from '@/lib/queries';
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
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar name={p?.displayName ?? '?'} size={18} />
      <span className="truncate">{p?.displayName ?? '…'}</span>
    </span>
  );
}

export function PurchaseClassSelect({ value, onChange, id, includeAll, allLabel = 'All purchase classes' }: { value: string | null; onChange: (v: string | null) => void; id?: string; includeAll?: boolean; allLabel?: string }) {
  const classes = usePurchaseClasses();
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {includeAll ? <option value="">{allLabel}</option> : <option value="" disabled>Select a purchase class</option>}
      {(classes.data ?? [])
        .filter((c) => !c.archived || c.id === value)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </Select>
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
