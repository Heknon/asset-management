import { addDuration, isRestricted, type AssetFilter, type AssetType, type FieldDefinition, type FilterOp } from '@am/core';
import { ListFilter, Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { t } from '@/lib/i18n';
import { tj } from '@/lib/i18n-react';
import { usePeople } from '@/lib/queries';
import { formatDate, todayIso } from '@/lib/utils';
import { AttributeInput } from './attribute';
import { Button } from './ui/button';
import { Field, Input, Select } from './ui/form';
import { Popover } from './ui/overlay';

/**
 * Plain-language filters on any field: "Seats is at least 40", "Renewal date
 * is in the next 90 days", "Vendor contains adobe". Operators adapt to the
 * field's type; value inputs reuse the same controls as the asset form.
 */

type Kind = 'text' | 'number' | 'date' | 'choice' | 'multi' | 'boolean' | 'person';

interface FilterField {
  key: AssetFilter['field'];
  label: string;
  kind: Kind;
  definition?: FieldDefinition;
}

const OPS: Record<Kind, Array<{ op: FilterOp; label: string }>> = {
  text: [
    { op: 'contains', label: t('contains') },
    { op: 'equals', label: t('is') },
    { op: 'notEquals', label: t('is not') },
    { op: 'isEmpty', label: t('is empty') },
    { op: 'isNotEmpty', label: t('is not empty') },
  ],
  number: [
    { op: 'equals', label: t('is') },
    { op: 'gte', label: t('is at least') },
    { op: 'gt', label: t('is more than') },
    { op: 'lte', label: t('is at most') },
    { op: 'lt', label: t('is less than') },
    { op: 'between', label: t('is between') },
    { op: 'isEmpty', label: t('is empty') },
  ],
  date: [
    { op: 'between', label: t('is between') },
    { op: 'lt', label: t('is before') },
    { op: 'gt', label: t('is after') },
    { op: 'equals', label: t('is on') },
    { op: 'isEmpty', label: t('is empty') },
    { op: 'isNotEmpty', label: t('is set') },
  ],
  choice: [
    { op: 'equals', label: t('is') },
    { op: 'notEquals', label: t('is not') },
    { op: 'in', label: t('is any of') },
    { op: 'isEmpty', label: t('is empty') },
  ],
  multi: [
    { op: 'contains', label: t('includes') },
    { op: 'in', label: t('includes any of') },
    { op: 'isEmpty', label: t('is empty') },
  ],
  boolean: [{ op: 'equals', label: t('is') }],
  person: [
    { op: 'equals', label: t('is') },
    { op: 'notEquals', label: t('is not') },
    { op: 'isEmpty', label: t('is not set') },
  ],
};

function kindOf(f: FieldDefinition): Kind {
  switch (f.kind) {
    case 'number':
    case 'currency':
      return 'number';
    case 'date':
      return 'date';
    case 'select':
      return 'choice';
    case 'multiSelect':
      return 'multi';
    case 'boolean':
      return 'boolean';
    case 'user':
      return 'person';
    default:
      return 'text';
  }
}

export function filterFields(type: AssetType | undefined): FilterField[] {
  const system: FilterField[] = [
    { key: 'name', label: t('Name'), kind: 'text' },
    { key: 'ownerId', label: t('Owner'), kind: 'person', definition: { id: 'owner', key: 'owner', label: t('Owner'), kind: 'user', required: false, restricted: false, showInTable: false, config: {} } },
    { key: 'createdAt', label: t('Created'), kind: 'date' },
    { key: 'updatedAt', label: t('Last updated'), kind: 'date' },
  ];
  const own = (type?.fields ?? [])
    .filter((f) => !isRestricted(f) && f.kind !== 'longText' && f.kind !== 'assetRef')
    .map((f): FilterField => ({ key: `attributes.${f.key}`, label: f.label, kind: kindOf(f), definition: f }));
  return [...own, ...system];
}

const needsValue = (op: FilterOp) => op !== 'isEmpty' && op !== 'isNotEmpty';

/** Quick ranges for dates, the most common question ("what renews soon?"). */
const DATE_PRESETS = [
  { label: t('Next 30 days'), days: 30 },
  { label: t('Next 90 days'), days: 90 },
  { label: t('Next 12 months'), days: 365 },
  { label: t('Already passed'), days: -1 },
];

function Editor({ fields, initial, onSave, onCancel }: { fields: FilterField[]; initial?: AssetFilter; onSave: (f: AssetFilter) => void; onCancel: () => void }) {
  const [fieldKey, setFieldKey] = useState(initial?.field ?? fields[0]?.key ?? 'name');
  const field = fields.find((f) => f.key === fieldKey) ?? fields[0]!;
  const ops = OPS[field.kind];
  const [op, setOp] = useState<FilterOp>(initial?.op ?? ops[0]!.op);
  const [value, setValue] = useState<unknown>(initial?.value ?? (field.kind === 'boolean' ? true : undefined));
  const activeOp = ops.some((o) => o.op === op) ? op : ops[0]!.op;
  const definition: FieldDefinition | undefined =
    field.definition && activeOp === 'in' && (field.kind === 'choice' || field.kind === 'multi')
      ? ({ ...field.definition, kind: 'multiSelect' } as FieldDefinition)
      : field.definition;

  const input = (v: unknown, set: (v: unknown) => void, id: string) =>
    definition ? (
      <AttributeInput id={id} field={definition} value={v} onChange={set} />
    ) : field.kind === 'date' ? (
      <Input id={id} type="date" value={(v as string) ?? ''} onChange={(e) => set(e.target.value || undefined)} />
    ) : (
      <Input id={id} value={(v as string) ?? ''} onChange={(e) => set(e.target.value)} />
    );

  const range = Array.isArray(value) ? (value as unknown[]) : [undefined, undefined];
  const valid = !needsValue(activeOp) || (activeOp === 'between' ? range[0] !== undefined && range[1] !== undefined : value !== undefined && value !== '' && !(Array.isArray(value) && !value.length));

  return (
    <div className="w-full space-y-3 p-4 sm:w-80 sm:p-3">
      <Field label={t('Field')}>
        {(id) => (
          <Select
            id={id}
            value={fieldKey}
            onChange={(e) => {
              setFieldKey(e.target.value as AssetFilter['field']);
              setValue(undefined);
            }}
          >
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('Condition')}>
        {(id) => (
          <Select id={id} value={activeOp} onChange={(e) => (setOp(e.target.value as FilterOp), setValue(field.kind === 'boolean' ? true : undefined))}>
            {ops.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {needsValue(activeOp) && (
        <Field label={t('Value')}>
          {(id) =>
            activeOp === 'between' ? (
              <div className="space-y-2">
                {field.kind === 'date' && (
                  <div className="flex flex-wrap gap-1">
                    {DATE_PRESETS.map((p) => (
                      <Button
                        key={p.label}
                        size="xs"
                        onClick={() => setValue(p.days < 0 ? ['1900-01-01', addDuration(todayIso(), { amount: 1, unit: 'day' }, -1)] : [todayIso(), addDuration(todayIso(), { amount: p.days, unit: 'day' })])}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {input(range[0], (v) => setValue([v, range[1]]), `${id}-a`)}
                  {input(range[1], (v) => setValue([range[0], v]), `${id}-b`)}
                </div>
              </div>
            ) : field.kind === 'boolean' ? (
              <Select id={id} value={String(value ?? true)} onChange={(e) => setValue(e.target.value === 'true')}>
                <option value="true">{t('Yes')}</option>
                <option value="false">{t('No')}</option>
              </Select>
            ) : (
              input(value, setValue, id)
            )
          }
        </Field>
      )}
      <div className="flex justify-end gap-2 pt-1 max-sm:[&>*]:flex-1">
        <Button size="sm" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button size="sm" variant="primary" disabled={!valid} onClick={() => onSave({ field: field.key, op: activeOp, ...(needsValue(activeOp) && { value }) })}>
          {t('Apply')}
        </Button>
      </div>
    </div>
  );
}

function describe(f: AssetFilter, fields: FilterField[], people: Map<string, { displayName: string }>): ReactNode {
  const field = fields.find((x) => x.key === f.field);
  const label = OPS[field?.kind ?? 'text'].find((o) => o.op === f.op)?.label ?? f.op;
  const show = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return f.op === 'between' && v.length === 2 ? t('{from} and {to}', { from: show(v[0]), to: show(v[1]) }) : v.map(show).join(', ');
    if (typeof v === 'boolean') return v ? t('yes') : t('no');
    const def = field?.definition;
    if (def && (def.kind === 'select' || def.kind === 'multiSelect')) return def.config.options.find((o) => o.value === v)?.label ?? String(v);
    if (field?.kind === 'person') return people.get(String(v))?.displayName ?? '…';
    if (field?.kind === 'date' && typeof v === 'string') return formatDate(v);
    return String(v);
  };
  const parts = { field: <span className="font-medium">{field?.label ?? f.field}</span>, condition: <span className="text-muted">{label}</span> };
  return needsValue(f.op) ? tj('{field} {condition} {value}', { ...parts, value: <span className="font-medium">{show(f.value)}</span> }) : tj('{field} {condition}', parts);
}

export function FilterBar({ type, value, onChange }: { type: AssetType | undefined; value: AssetFilter[]; onChange: (f: AssetFilter[]) => void }) {
  const fields = filterFields(type);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const people = usePeople(value.filter((f) => f.field === 'ownerId' || fields.find((x) => x.key === f.field)?.kind === 'person').map((f) => f.value as string));
  return (
    <>
      {value.map((f, i) => (
        <Popover
          key={i}
          phoneTitle={t('Edit filter')}
          open={editing === i}
          onOpenChange={(o) => setEditing(o ? i : null)}
          trigger={
            <span className="inline-flex h-8 items-center gap-1 rounded-lg border border-accent/30 bg-accent-soft/60 pe-1 ps-2.5 text-[13px]">
              <button type="button" className="max-w-72 truncate">
                {describe(f, fields, people)}
              </button>
              <button
                type="button"
                aria-label={t('Remove filter')}
                className="rounded p-0.5 text-subtle hover:bg-surface-3 hover:text-fg"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((_, j) => j !== i));
                }}
              >
                <X className="size-3.5" />
              </button>
            </span>
          }
        >
          <Editor fields={fields} initial={f} onCancel={() => setEditing(null)} onSave={(nf) => (onChange(value.map((x, j) => (j === i ? nf : x))), setEditing(null))} />
        </Popover>
      ))}
      <Popover
        phoneTitle={t('Add a filter')}
        open={editing === 'new'}
        onOpenChange={(o) => setEditing(o ? 'new' : null)}
        trigger={
          <Button icon={value.length ? <Plus className="size-3.5" /> : <ListFilter className="size-3.5" />} title={type ? undefined : t('Pick an asset type to filter by its own fields')}>
            {value.length ? t('Filter') : t('Add filter')}
          </Button>
        }
      >
        <Editor fields={fields} onCancel={() => setEditing(null)} onSave={(f) => (onChange([...value, f]), setEditing(null))} />
        {!type && <p className="border-t border-border px-3 py-2 text-xs text-subtle">{t('Tip: choose an asset type to filter by its own fields (seats, renewal date, vendor…).')}</p>}
      </Popover>
    </>
  );
}
