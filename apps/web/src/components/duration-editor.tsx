import { describeDuration, durationUnits, type Duration, type DurationUnit } from '@am/core';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button';
import { Input, Select } from './ui/form';
import { Popover } from './ui/overlay';

export function DurationInput({ value, onChange, id }: { value: Duration; onChange: (d: Duration) => void; id?: string }) {
  return (
    <div className="flex gap-1.5">
      <Input id={id} type="number" min={0} className="w-20" value={value.amount} onChange={(e) => onChange({ ...value, amount: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })} />
      <Select className="w-28" value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as DurationUnit })}>
        {durationUnits.map((u) => (
          <option key={u} value={u}>
            {u}s
          </option>
        ))}
      </Select>
    </div>
  );
}

const toDays = (d: Duration) => d.amount * { day: 1, week: 7, month: 30, year: 365 }[d.unit];

/** Reminder offsets as removable chips; used for date kinds, fields and per-asset overrides. */
export function DurationListEditor({ value, onChange, emptyLabel = 'No reminders' }: { value: Duration[]; onChange: (v: Duration[]) => void; emptyLabel?: string }) {
  const [draft, setDraft] = useState<Duration>({ amount: 14, unit: 'day' });
  const [open, setOpen] = useState(false);
  const sorted = [...value].sort((a, b) => toDays(b) - toDays(a));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sorted.length === 0 && <span className="text-xs text-subtle">{emptyLabel}</span>}
      {sorted.map((d, i) => (
        <span key={`${d.amount}${d.unit}${i}`} className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-2 pr-1 pl-2 text-xs">
          {describeDuration(d)} before
          <button type="button" aria-label="Remove" className="rounded p-0.5 text-subtle hover:bg-surface-3 hover:text-fg" onClick={() => onChange(value.filter((x) => x !== d))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Popover
        open={open}
        onOpenChange={setOpen}
        className="p-3"
        trigger={<Button size="xs" variant="ghost" icon={<Plus className="size-3" />}>Add</Button>}
      >
        <div className="space-y-2">
          <DurationInput value={draft} onChange={setDraft} />
          <Button
            size="sm"
            variant="primary"
            className="w-full justify-center"
            onClick={() => {
              if (!value.some((v) => toDays(v) === toDays(draft))) onChange([...value, draft]);
              setOpen(false);
            }}
          >
            Add reminder
          </Button>
        </div>
      </Popover>
    </div>
  );
}
