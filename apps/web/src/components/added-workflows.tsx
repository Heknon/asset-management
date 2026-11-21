import { workflowPresets, type ExtraWorkflow } from '@am/core';
import { Boxes, ChevronDown, ChevronRight, Plus, ShoppingCart, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { useState } from 'react';
import { UnitPicker } from './pickers';
import { Button } from './ui/button';
import { Card } from './ui/display';
import { Field, Input, Segmented } from './ui/form';
import { Menu, MenuItem, MenuSeparator } from './ui/overlay';
import { WorkflowEditor } from './workflow-editor';
import { isRtl, t, tMaybe } from '@/lib/i18n';
import { slugKey } from '@/lib/utils';

/**
 * Workflows a template or a team variant adds besides the purchase: "Machine
 * status" on the item, "Swap the new license" on its requests. Each names the
 * unit responsible for it; everyone who sees the item sees its status.
 */
export function AddedWorkflowsEditor({
  value,
  onChange,
  saved = [],
  inherited = [],
  ownTeamLabel,
}: {
  value: ExtraWorkflow[];
  onChange: (v: ExtraWorkflow[]) => void;
  /** As last saved: their keys, and their statuses' keys, stay (items and requests keep their state under them). */
  saved?: ExtraWorkflow[];
  /** The template's own workflows, shown on a variant for context. */
  inherited?: ExtraWorkflow[];
  /** What "no responsible unit" means here ("The item's own team"). */
  ownTeamLabel: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const savedKeys = saved.map((w) => w.key);
  const taken = new Set([...value.map((w) => w.key), ...inherited.map((w) => w.key)]);
  const keyFor = (name: string) => {
    const base = slugKey(name) || 'workflow';
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
    return key;
  };
  const add = (w: Omit<ExtraWorkflow, 'key' | 'responsibleUnitId'>) => {
    const name = tMaybe(w.name);
    onChange([...value, { ...structuredClone(w), name, key: keyFor(w.name), responsibleUnitId: null }]);
    setOpen(value.length);
  };
  const patch = (i: number, p: Partial<ExtraWorkflow>) => onChange(value.map((w, j) => (j === i ? { ...w, ...p } : w)));
  const blank: Omit<ExtraWorkflow, 'key' | 'responsibleUnitId'> = {
    name: t('New workflow'),
    appliesTo: 'item',
    startsWhen: 'created',
    statuses: [
      { key: 'to_do', label: 'To do', color: '#6366f1', category: 'todo' },
      { key: 'in_progress', label: 'In progress', color: '#f59e0b', category: 'active' },
      { key: 'done', label: 'Done', color: '#10b981', category: 'done' },
    ],
    transitions: [
      { from: 'to_do', to: 'in_progress', by: 'handler' },
      { from: 'in_progress', to: 'done', by: 'handler' },
      { from: 'in_progress', to: 'to_do', by: 'handler' },
    ],
  };

  return (
    <Card padded={false}>
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">{t('More workflows')}</h2>
          <p className="text-xs text-muted">{t('Besides the purchase: e.g. a machine status on the item, or steps after a renewal. Each has a unit responsible for it; everyone sees where it stands.')}</p>
        </div>
        <Menu trigger={<Button size="sm" className="self-start sm:self-auto" icon={<Plus className="size-3.5" />}>{t('Add workflow')}</Button>}>
          <MenuItem icon={<Boxes />} onSelect={() => add(workflowPresets.machines)}>
            {t('Machine status (on the item)')}
          </MenuItem>
          <MenuItem icon={<ShoppingCart />} onSelect={() => add(workflowPresets.swap)}>
            {t('Swap the new license (after a renewal)')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<WorkflowIcon />} onSelect={() => add(blank)}>
            {t('Blank workflow')}
          </MenuItem>
        </Menu>
      </div>
      {inherited.length > 0 && (
        <ul className="divide-y divide-border border-b border-border bg-surface-2/40">
          {inherited.map((w) => (
            <li key={w.key} className="flex items-center gap-2 px-4 py-2.5 text-[13px] text-muted">
              <WorkflowIcon className="size-3.5" />
              <span className="font-medium text-fg">{tMaybe(w.name)}</span>
              <span className="text-xs">{t('From the template')}</span>
            </li>
          ))}
        </ul>
      )}
      {!value.length && <p className="px-4 py-4 text-[13px] text-muted">{t('No workflows yet. Requests still go through the purchase workflow.')}</p>}
      <ul className="divide-y divide-border">
        {value.map((w, i) => (
          <li key={i}>
            <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center gap-2 px-4 py-3 text-start text-[13px] hover:bg-surface-2/50">
              {open === i ? <ChevronDown className="size-4 text-subtle" /> : <ChevronRight className="size-4 text-subtle rtl:rotate-180" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{w.name}</span>
                <span className="block text-xs text-muted">
                  {w.appliesTo === 'item' ? t('On the item') : w.startsWhen === 'purchase_done' ? t('After the purchase') : t('With the purchase')} · {w.statuses.map((s) => tMaybe(s.label)).join(isRtl() ? ' ← ' : ' → ')}
                </span>
              </span>
            </button>
            {open === i && (
              <div className="space-y-4 px-4 pb-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label={t('Name')}>
                    {(id) => (
                      <Input
                        id={id}
                        value={w.name}
                        onChange={(e) => {
                          const name = e.target.value;
                          // New workflows take their key from the name; saved ones keep theirs.
                          patch(i, { name, ...(!savedKeys.includes(w.key) && { key: (taken.delete(w.key), keyFor(name)) }) });
                        }}
                      />
                    )}
                  </Field>
                  <Field label={t('Responsible')} hint={t('Its members (and the unit’s managers) move it')}>
                    {(id) => <UnitPicker id={id} value={w.responsibleUnitId} onChange={(responsibleUnitId) => patch(i, { responsibleUnitId })} allowClear clearLabel={ownTeamLabel} placeholder={ownTeamLabel} />}
                  </Field>
                  <Field label={t('Tracks')}>
                    {() => (
                      <Segmented
                        value={w.appliesTo}
                        onChange={(appliesTo) => patch(i, { appliesTo, ...(appliesTo === 'item' && { startsWhen: 'created' as const }) })}
                        options={[
                          { value: 'item', label: t('The item') },
                          { value: 'request', label: t('Each purchase or renewal') },
                        ]}
                      />
                    )}
                  </Field>
                  {w.appliesTo === 'request' && (
                    <Field label={t('Starts')}>
                      {() => (
                        <Segmented
                          value={w.startsWhen}
                          onChange={(startsWhen) => patch(i, { startsWhen })}
                          options={[
                            { value: 'created', label: t('With the request') },
                            { value: 'purchase_done', label: t('Once bought or renewed') },
                          ]}
                        />
                      )}
                    </Field>
                  )}
                </div>
                <WorkflowEditor added value={w} onChange={(wf) => patch(i, wf)} lockedKeys={saved.find((x) => x.key === w.key)?.statuses.map((s) => s.key) ?? []} />
                <div className="flex justify-end">
                  <Button size="sm" variant="danger-ghost" icon={<Trash2 className="size-3.5" />} onClick={() => (onChange(value.filter((_, j) => j !== i)), setOpen(null))}>
                    {t('Remove workflow')}
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
