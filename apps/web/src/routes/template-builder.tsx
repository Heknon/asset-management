import {
  defaultStatuses,
  durationUnits,
  fieldKindMeta,
  fieldKinds,
  type AssetStatus,
  type AssetType,
  type AssetTypeInput,
  type DateKind,
  type DateTracking,
  type DurationUnit,
  type FieldDefinition,
  type FieldKind,
  type SelectOption,
} from '@am/core';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  Archive,
  AtSign,
  Calendar,
  CalendarClock,
  CheckSquare,
  CircleDollarSign,
  Eye,
  GripVertical,
  Hash,
  Key,
  Link2,
  List,
  ListChecks,
  Lock,
  MoreHorizontal,
  Plus,
  Sparkles,
  Text,
  TextQuote,
  Trash2,
  UserRound,
  Boxes,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AttributeInput } from '@/components/attribute';
import { DurationInput, DurationListEditor } from '@/components/duration-editor';
import { ColorPicker, IconPicker, AssetTypeSelect } from '@/components/pickers';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/display';
import { Checkbox, Field, Input, Segmented, Select, Switch } from '@/components/ui/form';
import { Menu, MenuItem, Popover, Sheet } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { keys, useAssetType, useDateKinds } from '@/lib/queries';
import { cn, formatDurations, slugKey } from '@/lib/utils';

export const kindIcons: Record<FieldKind, LucideIcon> = {
  text: Text,
  longText: TextQuote,
  number: Hash,
  currency: CircleDollarSign,
  date: Calendar,
  boolean: CheckSquare,
  select: List,
  multiSelect: ListChecks,
  user: UserRound,
  url: Link2,
  email: AtSign,
  secret: Key,
  assetRef: Boxes,
};

const blankType = (): AssetTypeInput & { version?: number } => ({
  key: '',
  name: '',
  description: '',
  icon: 'box',
  color: '#6366f1',
  statuses: defaultStatuses,
  sections: [],
  fields: [],
});

function newField(kind: FieldKind, existingKeys: Set<string>): FieldDefinition {
  const label = fieldKindMeta[kind].label;
  let key = slugKey(label);
  for (let i = 2; existingKeys.has(key); i++) key = `${slugKey(label)}_${i}`;
  const base = { id: crypto.randomUUID(), key, label, required: false, restricted: false, showInTable: false };
  const config =
    kind === 'select' || kind === 'multiSelect'
      ? { options: [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }] }
      : kind === 'currency'
        ? { currency: 'USD', countsTowardSpend: false }
        : kind === 'number'
          ? { integer: false }
          : {};
  return { ...base, kind, config } as FieldDefinition;
}

export function TemplateBuilderPage() {
  const { typeId } = useParams({ strict: false }) as { typeId: string };
  const isNew = typeId === 'new';
  const existing = useAssetType(isNew ? undefined : typeId);
  const kinds = useDateKinds();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<AssetTypeInput & { version?: number; archived?: boolean }>(blankType);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (existing.data) {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = existing.data;
      setDraft(rest);
      setSavedKeys(new Set(existing.data.fields.map((f) => f.key)));
      setSelected(existing.data.fields[0]?.id ?? null);
      setDirty(false);
    }
  }, [existing.data]);

  const update = (patch: Partial<AssetTypeInput>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const updateField = (id: string, next: FieldDefinition) => update({ fields: draft.fields.map((f) => (f.id === id ? next : f)) });
  const field = draft.fields.find((f) => f.id === selected) ?? null;

  const save = useMutation({
    mutationFn: () => {
      const { version, archived: _a, ...input } = draft;
      const body = { ...input, key: input.key || slugKey(input.name) };
      return isNew ? api.post<AssetType>('/api/registry/asset-types', body) : api.put<AssetType>(`/api/registry/asset-types/${typeId}`, { ...body, version });
    },
    onSuccess: (t) => {
      setIssues([]);
      setDirty(false);
      void qc.invalidateQueries({ queryKey: keys.assetTypes });
      toast.success(isNew ? 'Template created' : `Saved as version ${t.version}`);
      if (isNew) void navigate({ to: '/templates/$typeId', params: { typeId: t.id } });
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        const list = (e.details?.issues as Array<{ path: string; message: string }>) ?? [];
        setIssues(list);
        toast.error(e.message, { description: list[0] ? `${list[0].path}: ${list[0].message}` : undefined });
      } else toast.error('Save failed');
    },
  });

  const archive = useMutation({
    mutationFn: (archived: boolean) => api.post<AssetType>(`/api/registry/asset-types/${typeId}/archive`, { archived }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: keys.assetTypes });
      toast.success(t.archived ? 'Template archived' : 'Template restored');
    },
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = draft.fields.findIndex((f) => f.id === active.id);
    const to = draft.fields.findIndex((f) => f.id === over.id);
    update({ fields: arrayMove(draft.fields, from, to) });
  };

  if (!isNew && existing.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        icon={<TypeIcon icon={draft.icon} color={draft.color} size={36} />}
        title={draft.name || 'Untitled template'}
        description={isNew ? 'New asset type' : `Version ${draft.version}${draft.archived ? ' · archived' : ''}${dirty ? ' · unsaved changes' : ''}`}
        actions={
          <>
            <Button icon={<Eye className="size-3.5" />} onClick={() => setPreviewOpen(true)}>
              Preview form
            </Button>
            {!isNew && (
              <Menu trigger={<Button size="icon" aria-label="More" icon={<MoreHorizontal className="size-4" />} />}>
                <MenuItem icon={<Archive />} onSelect={() => archive.mutate(!draft.archived)}>
                  {draft.archived ? 'Restore template' : 'Archive template'}
                </MenuItem>
              </Menu>
            )}
            <Button variant="primary" loading={save.isPending} disabled={!draft.name || (!dirty && !isNew)} onClick={() => save.mutate()}>
              {isNew ? 'Create template' : 'Save'}
            </Button>
          </>
        }
      />
      {issues.length > 0 && (
        <div className="mx-6 mt-4 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger">
          <p className="font-medium">Fix these before saving:</p>
          <ul className="mt-1 list-disc pl-5">
            {issues.map((i, n) => (
              <li key={n}>{describeIssue(i, draft.fields)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid min-h-0 flex-1 gap-6 px-6 py-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-6">
          <Card className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required>
              {(id) => <Input id={id} value={draft.name} placeholder="e.g. Software license" onChange={(e) => update({ name: e.target.value, ...(isNew && { key: slugKey(e.target.value) }) })} />}
            </Field>
            <Field label="Key" hint={isNew ? 'Stable identifier used in integrations' : 'Cannot be changed'}>
              {(id) => <Input id={id} value={draft.key} disabled={!isNew} className="font-mono text-xs" onChange={(e) => update({ key: e.target.value })} />}
            </Field>
            <Field label="Description" className="sm:col-span-2">
              {(id) => <Input id={id} value={draft.description ?? ''} onChange={(e) => update({ description: e.target.value })} />}
            </Field>
            <Field label="Color">{() => <ColorPicker value={draft.color} onChange={(color) => update({ color })} />}</Field>
            <Field label="Icon">{() => <IconPicker value={draft.icon} color={draft.color} onChange={(icon) => update({ icon })} />}</Field>
          </Card>

          <Card padded={false}>
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-semibold">Fields</h2>
              <AddFieldMenu
                onAdd={(kind) => {
                  const f = newField(kind, new Set(draft.fields.map((x) => x.key)));
                  update({ fields: [...draft.fields, f] });
                  setSelected(f.id);
                }}
              />
            </div>
            {draft.fields.length === 0 ? (
              <EmptyState icon={<Plus />} title="No fields yet" description="Add the attributes every asset of this type should have — dates you mark as tracked drive reminders." />
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={draft.fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                  <ul className="divide-y divide-border">
                    {draft.fields.map((f) => (
                      <FieldRow key={f.id} field={f} kinds={kinds.data ?? []} active={f.id === selected} onSelect={() => setSelected(f.id)} hasIssue={issues.some((i) => i.path.startsWith(`fields.${draft.fields.indexOf(f)}.`))} />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            )}
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <StatusesEditor value={draft.statuses} onChange={(statuses) => update({ statuses })} />
            <SectionsEditor value={draft.sections} fields={draft.fields} onChange={(sections, fields) => update({ sections, fields })} />
          </div>
        </div>

        <div className="xl:sticky xl:top-6 xl:self-start">
          {field ? (
            <FieldInspector
              key={field.id}
              field={field}
              fields={draft.fields}
              sections={draft.sections}
              kinds={kinds.data ?? []}
              keyLocked={savedKeys.has(field.key)}
              onChange={(next) => updateField(field.id, next)}
              onRemove={() => {
                update({ fields: draft.fields.filter((f) => f.id !== field.id) });
                setSelected(null);
              }}
            />
          ) : (
            <Card>
              <EmptyState title="Select a field" description="Pick a field on the left to configure it." />
            </Card>
          )}
        </div>
      </div>
      <FormPreview open={previewOpen} onOpenChange={setPreviewOpen} draft={draft} kinds={kinds.data ?? []} />
    </>
  );
}

function describeIssue(issue: { path: string; message: string }, fields: FieldDefinition[]) {
  const m = /^fields\.(\d+)/.exec(issue.path);
  const f = m ? fields[Number(m[1])] : undefined;
  return f ? `${f.label}: ${issue.message}` : issue.message;
}

function AddFieldMenu({ onAdd }: { onAdd: (k: FieldKind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} align="end" className="w-[420px] p-2" trigger={<Button size="sm" variant="primary" icon={<Plus className="size-3.5" />}>Add field</Button>}>
      <div className="grid grid-cols-2 gap-1">
        {fieldKinds.map((k) => {
          const Icon = kindIcons[k];
          return (
            <button
              key={k}
              type="button"
              onClick={() => {
                onAdd(k);
                setOpen(false);
              }}
              className="flex items-start gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-surface-2"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                <Icon className="size-4" />
              </span>
              <span>
                <span className="block text-[13px] font-medium">{fieldKindMeta[k].label}</span>
                <span className="block text-xs text-muted">{fieldKindMeta[k].description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

function FieldRow({ field, kinds, active, onSelect, hasIssue }: { field: FieldDefinition; kinds: DateKind[]; active: boolean; onSelect: () => void; hasIssue: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id });
  const Icon = kindIcons[field.kind];
  const tracking = field.kind === 'date' ? field.config.tracking : undefined;
  const kind = tracking && kinds.find((k) => k.id === tracking.dateKindId);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex items-center gap-2 bg-surface px-2 py-2', isDragging && 'relative z-10 shadow-pop', active && 'bg-accent-soft/50')}
    >
      <button type="button" className="cursor-grab rounded p-1 text-subtle hover:bg-surface-2 active:cursor-grabbing" aria-label="Reorder" {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </button>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md', active ? 'bg-accent text-white' : 'bg-surface-2 text-muted')}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[13px] font-medium', hasIssue && 'text-danger')}>{field.label}</span>
          <span className="block truncate font-mono text-[11px] text-subtle">
            {field.key}
            {field.section ? ` · ${field.section}` : ''}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {kind && (
            <Badge color={kind.color}>
              {tracking?.derive && <Sparkles className="size-3" />}
              {kind.name}
            </Badge>
          )}
          {field.required && <Badge>Required</Badge>}
          {(field.restricted || field.kind === 'secret') && (
            <Badge>
              <Lock className="size-3" />
            </Badge>
          )}
        </span>
      </button>
    </li>
  );
}

function FieldInspector({
  field,
  fields,
  sections,
  kinds,
  keyLocked,
  onChange,
  onRemove,
}: {
  field: FieldDefinition;
  fields: FieldDefinition[];
  sections: string[];
  kinds: DateKind[];
  keyLocked: boolean;
  onChange: (f: FieldDefinition) => void;
  onRemove: () => void;
}) {
  const [autoKey, setAutoKey] = useState(!keyLocked);
  const set = (patch: Partial<FieldDefinition>) => onChange({ ...field, ...patch } as FieldDefinition);
  const setConfig = (patch: Record<string, unknown>) => onChange({ ...field, config: { ...field.config, ...patch } } as FieldDefinition);
  const Icon = kindIcons[field.kind];

  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-md bg-surface-2 text-muted">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold">{field.label}</p>
          <p className="text-xs text-muted">{fieldKindMeta[field.kind].label}</p>
        </div>
        <Button size="icon" variant="danger-ghost" aria-label="Remove field" icon={<Trash2 className="size-4" />} onClick={onRemove} />
      </div>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Label">
            {(id) => <Input id={id} value={field.label} onChange={(e) => set({ label: e.target.value, ...(autoKey && { key: slugKey(e.target.value) }) })} />}
          </Field>
          <Field label="Key" hint={keyLocked ? 'Has data; locked' : undefined}>
            {(id) => (
              <Input
                id={id}
                className="font-mono text-xs"
                value={field.key}
                disabled={keyLocked}
                onChange={(e) => {
                  setAutoKey(false);
                  set({ key: e.target.value });
                }}
              />
            )}
          </Field>
        </div>
        <Field label="Help text">{(id) => <Input id={id} value={field.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} />}</Field>
        <Field label="Section">
          {(id) => (
            <Select id={id} value={field.section ?? ''} onChange={(e) => set({ section: e.target.value || undefined })}>
              <option value="">No section</option>
              {sections.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="space-y-2.5 rounded-lg bg-surface-2/60 p-3">
          <Switch checked={field.required} onChange={(required) => set({ required })} label="Required" />
          <Switch
            checked={field.restricted || field.kind === 'secret'}
            disabled={field.kind === 'secret'}
            onChange={(restricted) => set({ restricted })}
            label="Restricted"
            description="Only managers of the purchase class can see or edit it"
          />
          <Switch checked={field.showInTable} onChange={(showInTable) => set({ showInTable })} label="Show as table column" />
        </div>

        <KindConfig field={field} fields={fields} kinds={kinds} setConfig={setConfig} />
      </div>
    </Card>
  );
}

function KindConfig({ field, fields, kinds, setConfig }: { field: FieldDefinition; fields: FieldDefinition[]; kinds: DateKind[]; setConfig: (p: Record<string, unknown>) => void }) {
  switch (field.kind) {
    case 'text':
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Placeholder">{(id) => <Input id={id} value={field.config.placeholder ?? ''} onChange={(e) => setConfig({ placeholder: e.target.value || undefined })} />}</Field>
          <Field label="Max length">{(id) => <Input id={id} type="number" min={1} value={field.config.maxLength ?? ''} onChange={(e) => setConfig({ maxLength: e.target.value ? Number(e.target.value) : undefined })} />}</Field>
          <Field label="Pattern (regex)" className="col-span-2" hint="Optional validation, e.g. ^[0-9]{18,22}$">
            {(id) => <Input id={id} className="font-mono text-xs" value={field.config.pattern ?? ''} onChange={(e) => setConfig({ pattern: e.target.value || undefined })} />}
          </Field>
        </div>
      );
    case 'number':
      return (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Min">{(id) => <Input id={id} type="number" value={field.config.min ?? ''} onChange={(e) => setConfig({ min: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>
          <Field label="Max">{(id) => <Input id={id} type="number" value={field.config.max ?? ''} onChange={(e) => setConfig({ max: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>
          <Field label="Unit">{(id) => <Input id={id} value={field.config.unit ?? ''} placeholder="mo" onChange={(e) => setConfig({ unit: e.target.value || undefined })} />}</Field>
          <div className="col-span-3">
            <Checkbox checked={field.config.integer} onChange={(integer) => setConfig({ integer })} label="Whole numbers only" />
          </div>
        </div>
      );
    case 'currency':
      return (
        <div className="space-y-3">
          <Field label="Currency">{(id) => <Input id={id} className="w-24 uppercase" maxLength={3} value={field.config.currency} onChange={(e) => setConfig({ currency: e.target.value.toUpperCase() })} />}</Field>
          <Switch checked={field.config.countsTowardSpend} onChange={(countsTowardSpend) => setConfig({ countsTowardSpend })} label="Counts toward spend" description="Included in 'renewing in 90 days' totals" />
        </div>
      );
    case 'select':
    case 'multiSelect':
      return <OptionsEditor value={field.config.options} onChange={(options) => setConfig({ options })} />;
    case 'assetRef':
      return <Field label="Linked asset type">{(id) => <AssetTypeSelect id={id} includeAll allLabel="Any type" value={field.config.assetTypeId ?? null} onChange={(v) => setConfig({ assetTypeId: v ?? undefined })} />}</Field>;
    case 'date':
      return <DateMeaning field={field} fields={fields} kinds={kinds} onChange={(tracking) => setConfig({ tracking })} />;
    default:
      return null;
  }
}

/**
 * "What is this date?" — the generic answer to renewals/expiries/deadlines:
 * pick a date kind, optionally derive it from another date, and tune
 * recurrence, reminders and recipients.
 */
function DateMeaning({ field, fields, kinds, onChange }: { field: Extract<FieldDefinition, { kind: 'date' }>; fields: FieldDefinition[]; kinds: DateKind[]; onChange: (t: DateTracking | undefined) => void }) {
  const t = field.config.tracking;
  const kind = t && kinds.find((k) => k.id === t.dateKindId);
  const otherDates = fields.filter((f) => f.kind === 'date' && f.key !== field.key);
  const numbers = fields.filter((f) => f.kind === 'number');
  const users = fields.filter((f) => f.kind === 'user');
  const set = (patch: Partial<DateTracking>) => onChange({ ...t!, ...patch });
  const [emailDraft, setEmailDraft] = useState('');

  return (
    <div className="space-y-4 rounded-xl border border-border p-3">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 text-accent" />
        <p className="text-[13px] font-semibold">What is this date?</p>
      </div>
      <Select
        value={t?.dateKindId ?? ''}
        onChange={(e) => onChange(e.target.value ? { dateKindId: e.target.value, notify: t?.notify ?? { owner: true, userFields: [], emails: [] }, derive: t?.derive, recurrence: t?.recurrence, reminders: t?.reminders } : undefined)}
      >
        <option value="">Just a date (not tracked)</option>
        {kinds
          .filter((k) => !k.archived || k.id === t?.dateKindId)
          .map((k) => (
            <option key={k.id} value={k.id}>
              {k.name} — {k.behavior === 'recurring' ? 'repeats' : k.behavior === 'milestone' ? 'one-off' : 'no reminders'}
            </option>
          ))}
      </Select>

      {t && kind && (
        <>
          <Field label="Value">
            {() => (
              <Segmented
                value={t.derive ? 'derived' : 'entered'}
                onChange={(v) =>
                  set({
                    derive: v === 'derived' && otherDates[0] ? { from: otherDates[0].key, direction: 'before', amount: { fixed: 30 }, unit: 'day' } : undefined,
                  })
                }
                options={[
                  { value: 'entered', label: 'Entered by users' },
                  { value: 'derived', label: 'Calculated' },
                ]}
              />
            )}
          </Field>
          {t.derive && (
            <div className="grid grid-cols-[auto_1fr] items-center gap-2 text-[13px]">
              {numbers.length > 0 && (
                <Select className="col-span-2" value={'field' in t.derive.amount ? `field:${t.derive.amount.field}` : 'fixed'} onChange={(e) => set({ derive: { ...t.derive!, amount: e.target.value === 'fixed' ? { fixed: 30 } : { field: e.target.value.slice(6) } } })}>
                  <option value="fixed">A fixed offset</option>
                  {numbers.map((n) => (
                    <option key={n.key} value={`field:${n.key}`}>
                      The value of “{n.label}”
                    </option>
                  ))}
                </Select>
              )}
              <div className="col-span-2 flex flex-wrap items-center gap-1.5">
                {'fixed' in t.derive.amount && <Input type="number" min={0} className="w-20" value={t.derive.amount.fixed} onChange={(e) => set({ derive: { ...t.derive!, amount: { fixed: Math.max(0, Number(e.target.value) || 0) } } })} />}
                <Select className="w-24" value={t.derive.unit} onChange={(e) => set({ derive: { ...t.derive!, unit: e.target.value as DurationUnit } })}>
                  {durationUnits.map((u) => (
                    <option key={u} value={u}>
                      {u}s
                    </option>
                  ))}
                </Select>
                <Select className="w-24" value={t.derive.direction} onChange={(e) => set({ derive: { ...t.derive!, direction: e.target.value as 'before' | 'after' } })}>
                  <option value="before">before</option>
                  <option value="after">after</option>
                </Select>
                <Select className="min-w-36 flex-1" value={t.derive.from} onChange={(e) => set({ derive: { ...t.derive!, from: e.target.value } })}>
                  {otherDates.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </div>
              {!otherDates.length && <p className="col-span-2 text-xs text-danger">Add another date field to calculate from.</p>}
            </div>
          )}

          {kind.behavior === 'recurring' && !t.derive && (
            <Field label="Repeats every" hint={kind.defaultRecurrence ? `Default for ${kind.name}: every ${kind.defaultRecurrence.amount} ${kind.defaultRecurrence.unit}(s)` : undefined}>
              {() => (
                <div className="space-y-2">
                  <Select
                    value={t.recurrence ? (t.recurrence.mode === 'fixed' ? 'fixed' : `field:${t.recurrence.field}`) : 'default'}
                    onChange={(e) => {
                      const v = e.target.value;
                      set({ recurrence: v === 'default' ? undefined : v === 'fixed' ? { mode: 'fixed', every: kind.defaultRecurrence ?? { amount: 1, unit: 'year' } } : { mode: 'field', field: v.slice(6), unit: 'month' } });
                    }}
                  >
                    <option value="default">Use the date kind's default</option>
                    <option value="fixed">A fixed interval</option>
                    {numbers.map((n) => (
                      <option key={n.key} value={`field:${n.key}`}>
                        The value of “{n.label}”
                      </option>
                    ))}
                  </Select>
                  {t.recurrence?.mode === 'fixed' && <DurationInput value={t.recurrence.every} onChange={(every) => set({ recurrence: { mode: 'fixed', every } })} />}
                  {t.recurrence?.mode === 'field' && (
                    <Select className="w-32" value={t.recurrence.unit} onChange={(e) => set({ recurrence: { ...t.recurrence!, unit: e.target.value as DurationUnit } as DateTracking['recurrence'] })}>
                      {durationUnits.map((u) => (
                        <option key={u} value={u}>
                          in {u}s
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
              )}
            </Field>
          )}

          {kind.behavior !== 'informational' && (
            <>
              <Field label="Reminders" aside={<Checkbox checked={!!t.reminders} onChange={(c) => set({ reminders: c ? kind.defaultReminders : undefined })} label={<span className="text-xs">Custom</span>} />}>
                {() => (t.reminders ? <DurationListEditor value={t.reminders} onChange={(reminders) => set({ reminders })} /> : <p className="text-xs text-muted">{formatDurations(kind.defaultReminders)} (from {kind.name})</p>)}
              </Field>
              <Field label="Notify">
                {() => (
                  <div className="space-y-2">
                    <Checkbox checked={t.notify.owner} onChange={(owner) => set({ notify: { ...t.notify, owner } })} label="Asset owner" />
                    {users.map((u) => (
                      <Checkbox
                        key={u.key}
                        checked={t.notify.userFields.includes(u.key)}
                        onChange={(c) => set({ notify: { ...t.notify, userFields: c ? [...t.notify.userFields, u.key] : t.notify.userFields.filter((k) => k !== u.key) } })}
                        label={`Person in “${u.label}”`}
                      />
                    ))}
                    <div className="flex flex-wrap gap-1">
                      {t.notify.emails.map((e) => (
                        <Badge key={e}>
                          {e}
                          <button type="button" aria-label={`Remove ${e}`} onClick={() => set({ notify: { ...t.notify, emails: t.notify.emails.filter((x) => x !== e) } })}>
                            ×
                          </button>
                        </Badge>
                      ))}
                    </div>
                    <form
                      className="flex gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailDraft)) {
                          set({ notify: { ...t.notify, emails: [...new Set([...t.notify.emails, emailDraft.toLowerCase()])] } });
                          setEmailDraft('');
                        }
                      }}
                    >
                      <Input placeholder="Also email, e.g. procurement@corp.com" value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} />
                      <Button type="submit" size="md">
                        Add
                      </Button>
                    </form>
                  </div>
                )}
              </Field>
            </>
          )}
        </>
      )}
    </div>
  );
}

function OptionsEditor({ value, onChange }: { value: SelectOption[]; onChange: (v: SelectOption[]) => void }) {
  const colors = ['#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#0ea5e9', '#8b5cf6', '#64748b'];
  return (
    <Field label="Options">
      {() => (
        <div className="space-y-1.5">
          {value.map((o, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Change color"
                className="size-5 shrink-0 rounded-full"
                style={{ background: o.color ?? '#94a3b8' }}
                onClick={() => onChange(value.map((x, j) => (j === i ? { ...x, color: colors[(colors.indexOf(x.color ?? '') + 1) % colors.length] } : x)))}
              />
              <Input value={o.label} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, label: e.target.value, value: x.value.startsWith('option_') ? slugKey(e.target.value) || x.value : x.value } : x)))} />
              <Button size="icon" variant="ghost" aria-label="Remove option" disabled={value.length === 1} icon={<Trash2 className="size-3.5" />} onClick={() => onChange(value.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...value, { value: `option_${value.length + 1}`, label: `Option ${value.length + 1}` }])}>
            Add option
          </Button>
        </div>
      )}
    </Field>
  );
}

function StatusesEditor({ value, onChange }: { value: AssetStatus[]; onChange: (v: AssetStatus[]) => void }) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Statuses</h2>
        <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={() => onChange([...value, { value: `status_${value.length + 1}`, label: 'New status', color: '#64748b', active: true }])}>
          Add
        </Button>
      </div>
      <ul className="space-y-1.5">
        {value.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
            <Input value={s.label} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, label: e.target.value, value: x.value.startsWith('status_') ? slugKey(e.target.value) : x.value } : x)))} />
            <Checkbox checked={s.active} onChange={(active) => onChange(value.map((x, j) => (j === i ? { ...x, active } : x)))} label={<span className="text-xs whitespace-nowrap">Reminds</span>} />
            <Button size="icon" variant="ghost" aria-label="Remove status" disabled={value.length === 1} icon={<Trash2 className="size-3.5" />} onClick={() => onChange(value.filter((_, j) => j !== i))} />
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-subtle">The first status is the default. Statuses without “Reminds” (e.g. Retired) pause all reminders.</p>
    </Card>
  );
}

function SectionsEditor({ value, fields, onChange }: { value: string[]; fields: FieldDefinition[]; onChange: (sections: string[], fields: FieldDefinition[]) => void }) {
  const [draft, setDraft] = useState('');
  return (
    <Card>
      <h2 className="mb-3 text-[13px] font-semibold">Sections</h2>
      <div className="flex flex-wrap gap-1.5">
        {value.map((s) => (
          <Badge key={s}>
            {s}
            <span className="text-subtle">{fields.filter((f) => f.section === s).length}</span>
            <button
              type="button"
              aria-label={`Remove ${s}`}
              onClick={() =>
                onChange(
                  value.filter((x) => x !== s),
                  fields.map((f) => (f.section === s ? ({ ...f, section: undefined } as FieldDefinition) : f)),
                )
              }
            >
              ×
            </button>
          </Badge>
        ))}
      </div>
      <form
        className="mt-3 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const name = draft.trim();
          if (name && !value.includes(name)) onChange([...value, name], fields);
          setDraft('');
        }}
      >
        <Input placeholder="e.g. Commercial" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit">Add</Button>
      </form>
    </Card>
  );
}

/** Renders the form users will see, using the same field inputs as the real form. */
function FormPreview({ open, onOpenChange, draft, kinds }: { open: boolean; onOpenChange: (o: boolean) => void; draft: AssetTypeInput; kinds: DateKind[] }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const grouped = useMemo(() => {
    const out = new Map<string, FieldDefinition[]>();
    for (const f of draft.fields) out.set(f.section ?? '', [...(out.get(f.section ?? '') ?? []), f]);
    return [...out.entries()];
  }, [draft.fields]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`New ${draft.name.toLowerCase() || 'asset'}`} description="Preview — nothing is saved">
      <div className="space-y-6">
        {grouped.map(([section, fields]) => (
          <fieldset key={section || '_'}>
            {section && <legend className="mb-3 text-xs font-semibold tracking-wide text-subtle uppercase">{section}</legend>}
            <div className="grid grid-cols-2 gap-4">
              {fields.map((f) => {
                const t = f.kind === 'date' ? f.config.tracking : undefined;
                const k = t && kinds.find((x) => x.id === t.dateKindId);
                return (
                  <Field key={f.id} label={f.kind === 'boolean' ? '' : f.label} required={f.required} hint={k ? `${k.name}${t?.derive ? ' · calculated' : ''}` : f.description} className={f.kind === 'longText' || f.kind === 'multiSelect' ? 'col-span-2' : ''}>
                    {(id) =>
                      t?.derive ? (
                        <div className="flex h-8 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-xs text-muted">
                          <Sparkles className="size-3.5 text-accent" /> Calculated automatically
                        </div>
                      ) : (
                        <AttributeInput id={id} field={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
                      )
                    }
                  </Field>
                );
              })}
            </div>
          </fieldset>
        ))}
        {!draft.fields.length && <p className="text-[13px] text-muted">Add fields to see the form.</p>}
      </div>
    </Sheet>
  );
}

