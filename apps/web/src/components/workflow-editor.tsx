import { statusCategories, statusCategoryMeta, validateWorkflow, type StatusCategory, type Workflow, type WorkflowStatus } from '@am/core';
import { ArrowDown, ArrowUp, Flag, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { ColorPicker } from './pickers';
import { Button } from './ui/button';
import { Input, Select } from './ui/form';
import { Menu, MenuItem, Popover } from './ui/overlay';
import { useMediaQuery } from '@/lib/hooks';
import { cn, slugKey } from '@/lib/utils';

const categoryColor: Record<StatusCategory, string> = { todo: '#6366f1', active: '#f59e0b', done: '#10b981', closed: '#94a3b8' };

/**
 * Edits a request workflow as a list: each status has a name, a colour, a
 * category (what it means), and the statuses it can move to next. A move is
 * made by the people who handle requests, or also by the person who asked.
 */
export function WorkflowEditor({ value, onChange, lockedKeys = [] }: { value: Workflow; onChange: (w: Workflow) => void; lockedKeys?: string[] }) {
  const issues = validateWorkflow(value);
  const phone = useMediaQuery('(max-width: 639px)');
  const set = (statuses: WorkflowStatus[], transitions = value.transitions) => onChange({ statuses, transitions: transitions.filter((t) => statuses.some((s) => s.key === t.from) && statuses.some((s) => s.key === t.to)) });
  const patch = (i: number, p: Partial<WorkflowStatus>) => set(value.statuses.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...value.statuses];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    set(next);
  };
  const add = () => {
    const keys = new Set(value.statuses.map((s) => s.key));
    let key = 'new_status';
    for (let n = 2; keys.has(key); n++) key = `new_status_${n}`;
    set([...value.statuses, { key, label: 'New status', color: categoryColor.active, category: 'active' }]);
  };
  // Off → handlers → anyone (also the requester) → off.
  const cycle = (from: string, to: string) => {
    const t = value.transitions.find((x) => x.from === from && x.to === to);
    const rest = value.transitions.filter((x) => x !== t);
    onChange({ ...value, transitions: !t ? [...rest, { from, to, by: 'handler' }] : t.by === 'handler' ? [...rest, { from, to, by: 'requester' }] : rest });
  };

  return (
    <div className="space-y-3">
      <ol className="divide-y divide-border rounded-xl border border-border">
        {value.statuses.map((s, i) => {
          const locked = lockedKeys.includes(s.key);
          return (
            <li key={i} className="space-y-2.5 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-5 text-center text-xs text-subtle tabular-nums">{i + 1}</span>
                <Popover trigger={<button type="button" aria-label="Colour" className="size-5 shrink-0 rounded-full ring-1 ring-border" style={{ background: s.color }} />}>
                  <div className="w-56 p-1">
                    <ColorPicker value={s.color} onChange={(color) => patch(i, { color })} />
                  </div>
                </Popover>
                <Input
                  className="h-8 min-w-0 flex-1 sm:w-48 sm:flex-none"
                  value={s.label}
                  aria-label="Status name"
                  onChange={(e) => {
                    const label = e.target.value;
                    // New statuses take their key from the name; saved ones keep theirs (requests point at it).
                    const key = !locked && slugKey(label) && !value.statuses.some((x, j) => j !== i && x.key === slugKey(label)) ? slugKey(label) : s.key;
                    set(
                      value.statuses.map((x, j) => (j === i ? { ...x, label, key } : x)),
                      value.transitions.map((t) => ({ ...t, from: t.from === s.key ? key : t.from, to: t.to === s.key ? key : t.to })),
                    );
                  }}
                />
                {/* Phones: the meaning moves to its own line under the name. */}
                <span className="order-last flex basis-full items-center gap-2 pl-7 sm:order-none sm:basis-auto sm:pl-0">
                <Select className="h-8 w-36" value={s.category} title={statusCategoryMeta[s.category].description} aria-label="Meaning" onChange={(e) => patch(i, { category: e.target.value as StatusCategory })}>
                  {statusCategories.map((c) => (
                    <option key={c} value={c}>
                      {statusCategoryMeta[c].label}
                    </option>
                  ))}
                </Select>
                {i === 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted">
                    <Flag className="size-3" /> Requests start here
                  </span>
                )}
                </span>
                {phone ? (
                  <Menu trigger={<Button size="icon" variant="ghost" aria-label={`More for ${s.label}`} icon={<MoreHorizontal className="size-4" />} />}>
                    <MenuItem icon={<ArrowUp />} disabled={i === 0} onSelect={() => move(i, -1)}>
                      Move up
                    </MenuItem>
                    <MenuItem icon={<ArrowDown />} disabled={i === value.statuses.length - 1} onSelect={() => move(i, 1)}>
                      Move down
                    </MenuItem>
                    <MenuItem icon={<Trash2 />} danger disabled={value.statuses.length <= 3} onSelect={() => set(value.statuses.filter((_, j) => j !== i))}>
                      Remove status
                    </MenuItem>
                  </Menu>
                ) : (
                  <span className="ml-auto flex items-center">
                    <Button size="icon" variant="ghost" aria-label="Move up" disabled={i === 0} icon={<ArrowUp className="size-3.5" />} onClick={() => move(i, -1)} />
                    <Button size="icon" variant="ghost" aria-label="Move down" disabled={i === value.statuses.length - 1} icon={<ArrowDown className="size-3.5" />} onClick={() => move(i, 1)} />
                    <Button size="icon" variant="ghost" aria-label="Remove" disabled={value.statuses.length <= 3} icon={<Trash2 className="size-3.5" />} onClick={() => set(value.statuses.filter((_, j) => j !== i))} />
                  </span>
                )}
              </div>
              {s.category !== 'done' && s.category !== 'closed' ? (
                <div className="flex flex-wrap items-center gap-1.5 sm:pl-7">
                  <span className="mr-1 text-xs text-muted">Can move to</span>
                  {value.statuses
                    .filter((x) => x.key !== s.key)
                    .map((x) => {
                      const t = value.transitions.find((y) => y.from === s.key && y.to === x.key);
                      return (
                        <button
                          key={x.key}
                          type="button"
                          onClick={() => cycle(s.key, x.key)}
                          title={!t ? 'Not allowed — click to let handlers do it' : t.by === 'handler' ? 'Handlers — click to let the requester do it too' : 'Handlers and the requester — click to remove'}
                          className={cn(
                            'inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs transition-colors',
                            !t ? 'border-dashed border-border text-subtle hover:border-border-strong' : 'border-border-strong bg-surface-2 font-medium text-fg',
                          )}
                        >
                          <span className="size-1.5 rounded-full" style={{ background: t ? x.color : 'transparent', border: t ? undefined : `1px solid ${x.color}` }} />
                          {x.label}
                          {t?.by === 'requester' && <span className="text-[10px] font-normal text-muted">+ requester</span>}
                        </button>
                      );
                    })}
                </div>
              ) : (
                <ReopenRow s={s} value={value} onChange={onChange} />
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" icon={<Plus className="size-3.5" />} disabled={value.statuses.length >= 20} onClick={add}>
          Add status
        </Button>
        <span className="text-xs text-muted">Click a status chip to allow the move for handlers, again to let the requester make it too, and once more to remove it.</span>
      </div>
      {issues.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">
          {issues.map((x, i) => (
            <li key={i}>{x.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Finished statuses normally end the request; a closed one may be reopened. */
function ReopenRow({ s, value, onChange }: { s: WorkflowStatus; value: Workflow; onChange: (w: Workflow) => void }) {
  const out = value.transitions.filter((t) => t.from === s.key);
  if (s.category === 'done') return <p className="text-xs text-subtle sm:pl-7">Finished: a purchase got its item, a renewal rolled its date forward.</p>;
  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:pl-7">
      <span className="mr-1 text-xs text-muted">Can be reopened to</span>
      {value.statuses
        .filter((x) => x.category === 'todo' || x.category === 'active')
        .map((x) => {
          const on = out.some((t) => t.to === x.key);
          return (
            <button key={x.key} type="button" onClick={() => onChange({ ...value, transitions: on ? value.transitions.filter((t) => !(t.from === s.key && t.to === x.key)) : [...value.transitions, { from: s.key, to: x.key, by: 'handler' }] })} className={cn('inline-flex h-6 items-center rounded-md border px-2 text-xs', on ? 'border-border-strong bg-surface-2 font-medium' : 'border-dashed border-border text-subtle')}>
              {x.label}
            </button>
          );
        })}
    </div>
  );
}
