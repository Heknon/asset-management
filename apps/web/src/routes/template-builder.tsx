import {
  defaultRefPrefix,
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
  type TypeVariant,
  type TypeVariantInput,
  defaultWorkflow,
  type Workflow,
} from '@am/core';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
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
  Tags,
  Text,
  TextQuote,
  Trash2,
  UserRound,
  Boxes,
  type LucideIcon,
  Check,
  ChevronDown,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AttributeInput } from '@/components/attribute';
import { DurationInput, DurationListEditor } from '@/components/duration-editor';
import { ColorPicker, IconPicker, AssetTypeSelect, UnitPath, UnitPicker } from '@/components/pickers';
import { guessIcon, TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, SectionTitle, Spinner, Tabs } from '@/components/ui/display';
import { WorkflowEditor } from '@/components/workflow-editor';
import { Checkbox, Field, Input, Segmented, Select, Switch, TagInput } from '@/components/ui/form';
import { Drawer, Menu, MenuItem, Popover, Sheet } from '@/components/ui/overlay';
import { fieldPresets, makeField, type FieldPreset } from '@/lib/field-presets';
import { useMediaQuery, WIDE } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { keys, useAssetType, useDateKinds, useOrgWorkflow, useLookups, useVariants } from '@/lib/queries';
import { useMyOrg } from '@/lib/org';
import { useRemember } from '@/lib/recent';
import { cn, formatDurations, slugKey, inSentence } from '@/lib/utils';

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
  list: Tags,
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

export function TemplateBuilderPage() {
  const { typeId } = useParams({ strict: false }) as { typeId: string };
  const isNew = typeId === 'new';
  const existing = useAssetType(isNew ? undefined : typeId);
  const kinds = useDateKinds();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { name: startName } = useSearch({ strict: false }) as { name?: string };
  const [draft, setDraft] = useState<AssetTypeInput & { version?: number; archived?: boolean }>(() => ({ ...blankType(), ...(isNew && startName && { name: startName, key: slugKey(startName), icon: guessIcon(startName) ?? 'box' }) }));
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [iconPicked, setIconPicked] = useState(false);

  useEffect(() => {
    if (existing.data) {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = existing.data;
      setDraft(rest);
      setSavedKeys(new Set(existing.data.fields.map((f) => f.key)));
      // Opens on the live form preview; picking a field shows its settings.
      setSelected(null);
      setDirty(false);
    }
  }, [existing.data]);

  const update = (patch: Partial<AssetTypeInput>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

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

  useRemember(!isNew && existing.data ? { kind: 'template', id: existing.data.id, title: existing.data.name, subtitle: 'Template', icon: existing.data.icon, color: existing.data.color } : null);
  // ⌘S / Ctrl+S saves, as in any editor.
  const saveRef = useRef<() => void>(() => undefined);
  saveRef.current = () => {
    if (draft.name && (dirty || isNew) && !save.isPending) save.mutate();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const archive = useMutation({
    mutationFn: (archived: boolean) => api.post<AssetType>(`/api/registry/asset-types/${typeId}/archive`, { archived }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: keys.assetTypes });
      toast.success(t.archived ? 'Template archived' : 'Template restored');
    },
  });

  const wide = useMediaQuery(WIDE);
  const [tab, setTab] = useState('fields');

  if (!isNew && existing.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const issueTab = (path: string) => (path.startsWith('fields') ? 'fields' : path.startsWith('statuses') ? 'statuses' : path.startsWith('requestWorkflow') ? 'requests' : 'settings');
  const tabs = [
    { value: 'fields', label: 'Fields', count: draft.fields.length },
    { value: 'statuses', label: 'Statuses', count: draft.statuses.length },
    { value: 'requests', label: 'Requests' },
    ...(!isNew ? [{ value: 'variants', label: 'Team variants' }] : []),
    { value: 'settings', label: 'Settings' },
  ];

  return (
    <>
      <PageHeader
        icon={
          <Popover
            className="w-[min(22rem,calc(100vw-2rem))] space-y-3 p-3"
            trigger={
              <button type="button" aria-label="Change icon and color" className="rounded-xl transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-accent">
                <TypeIcon icon={draft.icon} color={draft.color} size={40} />
              </button>
            }
          >
            <ColorPicker value={draft.color} onChange={(color) => update({ color })} />
            <IconPicker value={draft.icon} color={draft.color} onChange={(icon) => (setIconPicked(true), update({ icon }))} />
          </Popover>
        }
        title={
          <input
            aria-label="Template name"
            value={draft.name}
            placeholder="Name this template"
            onChange={(e) => update({ name: e.target.value, ...(isNew && { key: slugKey(e.target.value), ...(!iconPicked && { icon: guessIcon(e.target.value) ?? 'box' }) }) })}
            className="-mx-1 w-full min-w-0 rounded-md bg-transparent px-1 outline-none placeholder:text-subtle hover:bg-surface-2/70 focus:bg-surface-2/70"
          />
        }
        description={
          // Grows to fit, so a longer description wraps on phones instead of being cut off; Enter finishes editing.
          <textarea
            aria-label="Description"
            rows={1}
            value={draft.description ?? ''}
            placeholder="Add a short description: what goes here, when to use it"
            onChange={(e) => update({ description: e.target.value.replace(/\n/g, ' ') })}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
            className="-mx-1 block w-full min-w-0 resize-none rounded-md bg-transparent px-1 outline-none field-sizing-content placeholder:text-subtle hover:bg-surface-2/70 focus:bg-surface-2/70"
          />
        }
        actions={
          <>
            <span className="text-xs text-subtle">{isNew ? 'Not created yet' : dirty ? 'Unsaved changes' : `Version ${draft.version}${draft.archived ? ' · archived' : ''}`}</span>
            {!wide && (
              <Button icon={<Eye className="size-3.5" />} onClick={() => setPreviewOpen(true)}>
                Preview
              </Button>
            )}
            {!isNew && (
              <Menu trigger={<Button size="icon" aria-label="More" icon={<MoreHorizontal className="size-4" />} />}>
                <MenuItem icon={<Archive />} onSelect={() => archive.mutate(!draft.archived)}>
                  {draft.archived ? 'Restore template' : 'Archive template'}
                </MenuItem>
              </Menu>
            )}
            <Button variant="primary" loading={save.isPending} disabled={!draft.name || (!dirty && !isNew)} onClick={() => save.mutate()} title="Save (⌘S)">
              {isNew ? 'Create template' : 'Save'}
            </Button>
          </>
        }
      >
        <Tabs value={tab} onValueChange={setTab} tabs={tabs} />
      </PageHeader>
      {issues.length > 0 && (
        <div className="mx-4 mt-4 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger sm:mx-6">
          <p className="font-medium">Fix these before saving:</p>
          <ul className="mt-1 list-disc pl-5">
            {issues.map((i, n) => (
              <li key={n}>
                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => setTab(issueTab(i.path))}>
                  {describeIssue(i, draft.fields)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tab === 'fields' && (
        <SchemaWorkbench
          fields={draft.fields}
          sections={draft.sections}
          issues={issues}
          savedKeys={savedKeys}
          kinds={kinds.data ?? []}
          selected={selected}
          onSelect={setSelected}
          onChange={(patch) => update(patch)}
          preview={draft}
        />
      )}
      {tab === 'statuses' && (
        <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
          <StatusesEditor value={draft.statuses} onChange={(statuses) => update({ statuses })} />
        </div>
      )}
      {tab === 'requests' && (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          <RequestWorkflowCard value={draft.requestWorkflow ?? null} saved={existing.data?.requestWorkflow ?? null} onChange={(requestWorkflow) => update({ requestWorkflow })} />
        </div>
      )}
      {tab === 'variants' && !isNew && (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          <TeamVariants typeId={typeId} />
        </div>
      )}
      {tab === 'settings' && (
        <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
          <Card className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Key" hint={isNew ? 'Stable identifier used in integrations and exports' : 'Cannot be changed'}>
              {(id) => <Input id={id} value={draft.key} disabled={!isNew} className="font-mono text-xs" onChange={(e) => update({ key: e.target.value })} />}
            </Field>
            <Field label="Item ID prefix" hint={`Items are numbered ${draft.refPrefix || defaultRefPrefix(draft.key || 'item')}-1, -2, … Changing it renames every ID.`}>
              {(id) => <Input id={id} className="w-28 font-mono uppercase" maxLength={6} value={draft.refPrefix ?? ''} placeholder={defaultRefPrefix(draft.key || 'item')} onChange={(e) => update({ refPrefix: e.target.value.toUpperCase() || undefined })} />}
            </Field>
          </Card>
        </div>
      )}
      <FormPreview open={previewOpen} onOpenChange={setPreviewOpen} draft={draft} kinds={kinds.data ?? []} />
    </>
  );
}

const sectionId = (name: string) => `s:${name}`;

/**
 * The fields of a template (or a team variant), grouped under their sections:
 * drag a field between sections, add a field where it belongs, rename a
 * section in place. Beside it the selected field's settings, or — with none
 * selected — the form as people will fill it in. `locked` fields (a variant's
 * template) are shown for context and cannot be changed here.
 */
function SchemaWorkbench({
  fields,
  sections,
  issues,
  savedKeys,
  kinds,
  selected,
  onSelect,
  onChange,
  info,
  locked,
  preview,
}: {
  fields: FieldDefinition[];
  sections: string[];
  issues: Array<{ path: string; message: string }>;
  savedKeys: Set<string>;
  kinds: DateKind[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (patch: { fields?: FieldDefinition[]; sections?: string[] }) => void;
  info?: React.ReactNode;
  locked?: { fields: FieldDefinition[]; sections: string[]; from: string };
  /** What the live form preview shows (template and variant fields together). */
  preview: Pick<AssetTypeInput, 'name' | 'fields' | 'sections'>;
}) {
  const field = fields.find((f) => f.id === selected) ?? null;
  const allKeys = new Set([...(locked?.fields ?? []), ...fields].map((x) => x.key));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const allSections = [...(locked?.sections ?? []), ...sections.filter((x) => !locked?.sections.includes(x))];
  const wide = useMediaQuery(WIDE);
  // Sections shown as headings: this editor's own, plus the template's ones its fields use.
  const shownSections = [...sections, ...allSections.filter((s) => !sections.includes(s) && fields.some((f) => f.section === s))];
  const items = [
    ...fields.filter((f) => !f.section || !shownSections.includes(f.section)).map((f) => f.id),
    ...shownSections.flatMap((s) => [sectionId(s), ...fields.filter((f) => f.section === s).map((f) => f.id)]),
  ];
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const order = arrayMove(items, items.indexOf(String(active.id)), items.indexOf(String(over.id)));
    // A field belongs to the nearest heading above it.
    let current: string | undefined;
    const next: FieldDefinition[] = [];
    for (const id of order) {
      if (id.startsWith('s:')) current = id.slice(2);
      else {
        const f = fields.find((x) => x.id === id)!;
        next.push({ ...f, section: current } as FieldDefinition);
      }
    }
    onChange({ fields: next });
  };
  const add = (from: FieldKind | FieldPreset, label?: string, section?: string) => {
    const f = { ...makeField(from, allKeys, kinds, label), section: section ?? field?.section ?? sections.at(-1) } as FieldDefinition;
    onChange({ fields: [...fields, f] });
    // Kinds open the settings to set them up; common fields are ready, so on smaller screens they just join the list.
    if (typeof from === 'string' || wide) onSelect(f.id);
  };
  const renameSection = (from: string, to: string) => {
    const name = to.trim();
    if (!name || name === from || allSections.includes(name)) return;
    onChange({ sections: sections.map((s) => (s === from ? name : s)), fields: fields.map((f) => (f.section === from ? ({ ...f, section: name } as FieldDefinition) : f)) });
  };
  const removeSection = (name: string) => onChange({ sections: sections.filter((s) => s !== name), fields: fields.map((f) => (f.section === name ? ({ ...f, section: undefined } as FieldDefinition) : f)) });
  const remove = (id: string) => {
    onChange({ fields: fields.filter((f) => f.id !== id) });
    onSelect(null);
  };
  const inspector = (plain: boolean) =>
    field && (
      <FieldInspector
        key={field.id}
        plain={plain}
        field={field}
        fields={[...(locked?.fields ?? []), ...fields]}
        sections={allSections}
        kinds={kinds}
        keyLocked={savedKeys.has(field.key)}
        onChange={(next) => onChange({ fields: fields.map((f) => (f.id === field.id ? next : f)) })}
        onRemove={() => remove(field.id)}
        onDone={() => onSelect(null)}
      />
    );
  const issueAt = (f: FieldDefinition) => issues.some((x) => x.path.startsWith(`fields.${fields.indexOf(f)}.`));

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 px-4 py-6 sm:px-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 space-y-6">
        {info}
        <Card padded={false}>
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold">{locked ? `Fields this team adds to ${locked.from}` : 'Fields'}</h2>
              <p className="text-xs text-muted max-sm:hidden">Drag to reorder or move between sections. Click one to set it up.</p>
            </div>
            <AddFieldMenu taken={allKeys} onAdd={(f, l) => add(f, l)} />
          </div>
          {locked && locked.fields.length > 0 && (
            <ul className="divide-y divide-border border-b border-border">
              {locked.fields.map((f) => (
                <LockedFieldRow key={f.id} field={f} from={locked.from} />
              ))}
            </ul>
          )}
          {fields.length === 0 && !shownSections.length && (
            <p className="px-4 pt-4 pb-1 text-[13px] text-muted">
              {locked ? 'Nothing added yet: e.g. the workstation, MAC addresses or the lab that uses it. The template’s fields above stay as they are.' : 'No fields yet. Pick the common ones below, or add any field with “Add field”. Tracked dates drive reminders and renewals.'}
            </p>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items} strategy={verticalListSortingStrategy}>
              <ul>
                {items.map((id) => {
                  if (id.startsWith('s:')) {
                    const s = id.slice(2);
                    return (
                      <SectionRow
                        key={id}
                        id={id}
                        name={s}
                        count={fields.filter((f) => f.section === s).length}
                        own={sections.includes(s)}
                        onRename={(to) => renameSection(s, to)}
                        onRemove={() => removeSection(s)}
                        addMenu={<AddFieldMenu compact taken={allKeys} onAdd={(f, l) => add(f, l, s)} />}
                      />
                    );
                  }
                  const f = fields.find((x) => x.id === id)!;
                  return <FieldRow key={id} field={f} kinds={kinds} active={f.id === selected} onSelect={() => onSelect(f.id === selected ? null : f.id)} hasIssue={issueAt(f)} />;
                })}
              </ul>
            </SortableContext>
          </DndContext>
          <NewSectionRow existing={allSections} onAdd={(name) => onChange({ sections: [...sections, name] })} />
          <SuggestedFields taken={allKeys} onAdd={(p) => add(p)} />
        </Card>
      </div>
      {wide ? (
        <div className="sticky top-6 self-start">
          {inspector(false) ?? <LivePreview draft={preview} kinds={kinds} onPick={onSelect} />}
        </div>
      ) : (
        <Drawer
          open={!!field}
          onOpenChange={(o) => !o && onSelect(null)}
          title={field?.label || 'Field'}
          description={field ? fieldKindMeta[field.kind].label : undefined}
          footer={
            <>
              <Button variant="danger-ghost" className="mr-auto" icon={<Trash2 className="size-4" />} onClick={() => field && remove(field.id)}>
                Remove
              </Button>
              <Button variant="primary" onClick={() => onSelect(null)}>
                Done
              </Button>
            </>
          }
        >
          {inspector(true)}
        </Drawer>
      )}
    </div>
  );
}

/** A section heading inside the field list: rename it in place, add a field to it, or remove it. */
function SectionRow({ id, name, count, own, onRename, onRemove, addMenu }: { id: string; name: string; count: number; own: boolean; onRename: (to: string) => void; onRemove: () => void; addMenu: React.ReactNode }) {
  const { setNodeRef, transform, transition } = useSortable({ id, disabled: true });
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="flex items-center gap-2 border-y border-border bg-surface-2/60 px-4 py-1.5 first:border-t-0">
      {editing ? (
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(value);
            setEditing(false);
          }}
        >
          <Input autoFocus aria-label="Section name" className="h-7 text-xs font-semibold" value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => (onRename(value), setEditing(false))} onKeyDown={(e) => e.key === 'Escape' && (setValue(name), setEditing(false))} />
        </form>
      ) : (
        <button type="button" disabled={!own} onClick={() => (setValue(name), setEditing(true))} className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold tracking-wide text-muted uppercase enabled:hover:text-fg" title={own ? 'Rename section' : 'From the template'}>
          {name} <span className="font-normal normal-case text-subtle">· {count}</span>
        </button>
      )}
      {addMenu}
      {own && (
        <Menu trigger={<Button size="icon" variant="ghost" className="size-7" aria-label={`More for ${name}`} icon={<MoreHorizontal className="size-3.5" />} />}>
          <MenuItem onSelect={() => (setValue(name), setEditing(true))}>Rename section</MenuItem>
          <MenuItem icon={<Trash2 />} danger onSelect={onRemove}>
            Remove section (keeps its fields)
          </MenuItem>
        </Menu>
      )}
    </li>
  );
}

function NewSectionRow({ existing, onAdd }: { existing: string[]; onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const submit = () => {
    const n = name.trim();
    if (n && !existing.includes(n)) onAdd(n);
    setName('');
    setOpen(false);
  };
  return open ? (
    <form
      className="flex items-center gap-2 border-t border-border px-4 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input autoFocus aria-label="New section name" className="h-8" placeholder="Section name, e.g. Commercial" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      <Button type="submit" size="sm" disabled={!name.trim()}>
        Add
      </Button>
    </form>
  ) : (
    <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center gap-2 border-t border-border px-4 py-2.5 text-left text-xs text-muted transition-colors hover:bg-surface-2/50 hover:text-fg">
      <Plus className="size-3.5" /> Add a section <span className="text-subtle max-sm:hidden">— groups fields on the form, e.g. Commercial, Term, Access</span>
    </button>
  );
}

/** Team variants of a template, on the template page. */
function TeamVariants({ typeId }: { typeId: string }) {
  const variants = useVariants();
  const list = (variants.data ?? []).filter((v) => v.assetTypeId === typeId);
  return (
    <Card padded={false}>
      <div className="border-b border-border px-4 py-2.5">
        <h2 className="text-[13px] font-semibold">Team variants</h2>
        <p className="text-xs text-muted">Units extend this template with their own fields. Changes here flow into every variant.</p>
      </div>
      {list.length ? (
        <ul className="divide-y divide-border">
          {list.map((v) => (
            <li key={v.id}>
              <Link to="/templates/$typeId/variants/$variantId" params={{ typeId, variantId: v.id }} className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-surface-2/50">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{v.name}</span>
                  <span className="block truncate text-xs text-muted">
                    <UnitPath id={v.unitId} /> · {v.fields.length} extra {v.fields.length === 1 ? 'field' : 'fields'}
                  </span>
                </span>
                {v.archived && <Badge>Archived</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-4 text-xs text-muted">None yet. A unit’s managers create them from the unit page (Templates tab).</p>
      )}
    </Card>
  );
}

/** A unit's extension of an organization template: name, the unit, and extra fields. */
export function VariantBuilderPage() {
  const { typeId, variantId } = useParams({ strict: false }) as { typeId: string; variantId: string };
  const { unit: unitParam } = useSearch({ strict: false }) as { unit?: string };
  const isNew = variantId === 'new';
  const type = useAssetType(typeId);
  const kinds = useDateKinds();
  const variants = useVariants();
  const existing = (variants.data ?? []).find((v) => v.id === variantId);
  const { unitPermissionsOn, canManageOrganization } = useMyOrg();
  const { unitById } = useLookups();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<TypeVariantInput & { version?: number; archived?: boolean }>({ unitId: unitParam ?? '', name: '', description: null, sections: [], fields: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
  const [dirty, setDirty] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const savedKeys = useMemo(() => new Set(existing?.fields.map((f) => f.key) ?? []), [existing]);

  useEffect(() => {
    if (existing) {
      setDraft({ unitId: existing.unitId, name: existing.name, description: existing.description, sections: existing.sections, fields: existing.fields, version: existing.version, archived: existing.archived });
      setDirty(false);
    }
  }, [existing]);

  const update = (patch: Partial<TypeVariantInput>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { name: draft.name, description: draft.description, sections: draft.sections, fields: draft.fields };
      return isNew ? api.post<TypeVariant>(`/api/registry/asset-types/${typeId}/variants`, { ...body, unitId: draft.unitId }) : api.put<TypeVariant>(`/api/registry/variants/${variantId}`, { ...body, version: draft.version });
    },
    onSuccess: (v) => {
      setIssues([]);
      setDirty(false);
      void qc.invalidateQueries({ queryKey: keys.variants });
      toast.success(isNew ? `“${v.name}” created` : 'Saved', { description: isNew ? `New ${inSentence(type.data?.name ?? '')} items in ${unitById.get(v.unitId)?.name} can now be a “${v.name}”.` : undefined });
      if (isNew) void navigate({ to: '/templates/$typeId/variants/$variantId', params: { typeId, variantId: v.id } });
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        const list = (e.details?.issues as Array<{ path: string; message: string }>) ?? [];
        setIssues(list);
        toast.error(e.message, { description: list[0] ? describeIssue(list[0], draft.fields) : undefined });
      } else toast.error('Save failed');
    },
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => api.post<TypeVariant>(`/api/registry/variants/${variantId}/archive`, { archived }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: keys.variants });
      toast.success(v.archived ? 'Variant archived' : 'Variant restored', { description: v.archived ? 'Existing items keep their fields; new items cannot use it.' : undefined });
    },
  });

  if (!type.data || (!isNew && !variants.data)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const t = type.data;
  const canManage = canManageOrganization || (!!draft.unitId && unitPermissionsOn(draft.unitId).has('manage'));

  return (
    <>
      <PageHeader
        icon={<TypeIcon icon={t.icon} color={t.color} size={36} />}
        title={draft.name || `New ${inSentence(t.name)} variant`}
        description={
          <span>
            A {t.name} variant{draft.unitId ? <> for <UnitPath id={draft.unitId} /></> : ''}
            {existing ? ` · version ${existing.version}${existing.archived ? ' · archived' : ''}` : ''}
            {dirty ? ' · unsaved changes' : ''}
          </span>
        }
        actions={
          <>
            <Button icon={<Eye className="size-3.5" />} onClick={() => setPreviewOpen(true)}>
              Preview form
            </Button>
            {!isNew && canManage && (
              <Menu trigger={<Button size="icon" aria-label="More" icon={<MoreHorizontal className="size-4" />} />}>
                <MenuItem icon={<Archive />} onSelect={() => archive.mutate(!draft.archived)}>
                  {draft.archived ? 'Restore variant' : 'Archive variant'}
                </MenuItem>
              </Menu>
            )}
            <Button variant="primary" loading={save.isPending} disabled={!canManage || !draft.name || !draft.unitId || (!dirty && !isNew)} onClick={() => save.mutate()}>
              {isNew ? 'Create variant' : 'Save'}
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
      <SchemaWorkbench
        fields={draft.fields}
        sections={draft.sections}
        issues={issues}
        savedKeys={savedKeys}
        kinds={kinds.data ?? []}
        selected={selected}
        onSelect={setSelected}
        onChange={(patch) => update(patch)}
        locked={{ fields: t.fields, sections: t.sections, from: t.name }}
        preview={{ name: draft.name || t.name, fields: [...t.fields, ...draft.fields], sections: [...t.sections, ...draft.sections] }}
        info={
          <Card className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" required hint="What this unit calls these items">
              {(id) => <Input id={id} value={draft.name} placeholder={`e.g. Design ${inSentence(t.name)}`} onChange={(e) => update({ name: e.target.value })} />}
            </Field>
            <Field label="For" required hint={isNew ? 'The unit and every team beneath it can use it' : 'Cannot be changed'}>
              {(id) =>
                isNew ? (
                  <UnitPicker id={id} value={draft.unitId || null} onChange={(v) => update({ unitId: v ?? '' })} filter={(u) => canManageOrganization || unitPermissionsOn(u.id).has('manage')} />
                ) : (
                  <p className="pt-2 text-[13px]">
                    <UnitPath id={draft.unitId} />
                  </p>
                )
              }
            </Field>
            <Field label="Description" className="sm:col-span-2">
              {(id) => <Input id={id} value={draft.description ?? ''} placeholder="When to use it" onChange={(e) => update({ description: e.target.value || null })} />}
            </Field>
          </Card>
        }
      />
      <FormPreview open={previewOpen} onOpenChange={setPreviewOpen} draft={{ ...t, fields: [...t.fields, ...draft.fields], sections: [...t.sections, ...draft.sections] }} kinds={kinds.data ?? []} />
    </>
  );
}

function describeIssue(issue: { path: string; message: string }, fields: FieldDefinition[]) {
  const m = /^fields\.(\d+)/.exec(issue.path);
  const f = m ? fields[Number(m[1])] : undefined;
  return f ? `${f.label}: ${issue.message}` : issue.message;
}

/**
 * Adding a field: common fields come ready to use (several can be added in a row),
 * any kind can be added blank, and typing a name adds it straight away.
 */
function AddFieldMenu({ onAdd, taken, compact = false }: { onAdd: (from: FieldKind | FieldPreset, label?: string) => void; taken: ReadonlySet<string>; /** A small "+" for a section heading. */ compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const phone = useMediaQuery('(max-width: 639px)');
  const trigger = compact ? (
    <Button size="icon" variant="ghost" className="size-7" aria-label="Add a field to this section" icon={<Plus className="size-3.5" />} onClick={phone ? () => setOpen(true) : undefined} />
  ) : (
    <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={phone ? () => setOpen(true) : undefined}>
      Add field
    </Button>
  );
  const close = () => {
    setOpen(false);
    setQ('');
  };
  const body = <AddFieldChooser q={q} onQ={setQ} taken={taken} onAdd={onAdd} onDone={close} />;
  return phone ? (
    <>
      {trigger}
      <Drawer open={open} onOpenChange={(o) => (o ? setOpen(true) : close())} title="Add a field" description="Pick common fields, or a kind of field to set up.">
        {body}
      </Drawer>
    </>
  ) : (
    <Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())} align="end" className="max-h-[var(--radix-popover-content-available-height)] w-[min(460px,calc(100vw-2rem))] overflow-y-auto p-0" trigger={trigger}>
      {body}
    </Popover>
  );
}

function AddFieldChooser({ q, onQ, taken, onAdd, onDone }: { q: string; onQ: (q: string) => void; taken: ReadonlySet<string>; onAdd: (from: FieldKind | FieldPreset, label?: string) => void; onDone: () => void }) {
  const needle = q.trim().toLowerCase();
  const presets = fieldPresets.filter((p) => !needle || p.label.toLowerCase().includes(needle) || p.hint.toLowerCase().includes(needle));
  const exact = presets.find((p) => p.label.toLowerCase() === needle);
  const quick = q.trim() && !exact ? q.trim() : null;
  const matching = fieldKinds.filter((k) => !needle || fieldKindMeta[k].label.toLowerCase().includes(needle) || fieldKindMeta[k].description.toLowerCase().includes(needle));
  // A new name can be any kind: offer them all.
  const kinds = quick && !matching.length ? [...fieldKinds] : matching;
  const first = () => {
    if (exact && !taken.has(slugKey(exact.label))) onAdd(exact);
    else if (quick) {
      onAdd(guessKind(quick), quick);
      onDone();
    } else if (presets[0]) onAdd(presets[0]);
    onQ('');
  };
  return (
    <div className="space-y-3 sm:p-2">
      <Input
        autoFocus={!matchMedia('(pointer: coarse)').matches}
        value={q}
        onChange={(e) => onQ(e.target.value)}
        placeholder="Field name, e.g. Contract owner"
        aria-label="Field name"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q.trim()) {
            e.preventDefault();
            first();
          }
        }}
      />
      {quick && (
        <button type="button" onClick={() => (onAdd(guessKind(quick), quick), onDone())} className="flex w-full items-center gap-2.5 rounded-lg bg-accent-soft/60 p-2 text-left text-[13px] transition-colors hover:bg-accent-soft">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-white">
            <Plus className="size-4" />
          </span>
          <span>
            Add “<span className="font-medium">{quick}</span>”
            <span className="block text-xs text-muted">as {fieldKindMeta[guessKind(quick)].label.toLowerCase()} · Enter</span>
          </span>
        </button>
      )}
      {presets.length > 0 && (
        <div>
          <p className="px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">Common fields</p>
          <div className="grid grid-cols-2 gap-1">
            {presets.map((p) => {
              const added = taken.has(slugKey(p.label));
              const Icon = p.dateKind ? CalendarClock : kindIcons[p.kind];
              return (
                <button
                  key={p.label}
                  type="button"
                  disabled={added}
                  onClick={() => onAdd(p)}
                  className="flex items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-surface-2 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md', added ? 'bg-success-soft text-success' : 'bg-surface-2 text-muted')}>{added ? <Check className="size-4" /> : <Icon className="size-4" />}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{p.label}</span>
                    <span className="block truncate text-xs text-muted">{added ? 'Added' : p.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {kinds.length > 0 && (
        <div>
          <p className="px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">{quick ? `Add “${quick}” as…` : 'Any kind of field'}</p>
          <div className="grid grid-cols-2 gap-1">
            {kinds.map((k) => {
              const Icon = kindIcons[k];
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    onAdd(k, quick ?? undefined);
                    onDone();
                  }}
                  className="flex items-start gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{fieldKindMeta[k].label}</span>
                    <span className="block text-xs text-muted">{fieldKindMeta[k].description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border px-1 pt-2">
        <span className="text-xs text-subtle">Common fields come set up; change anything later.</span>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** Common fields not added yet, one click each: building a template is mostly picking these. */
function SuggestedFields({ taken, onAdd }: { taken: ReadonlySet<string>; onAdd: (p: FieldPreset) => void }) {
  const left = fieldPresets.filter((p) => !taken.has(slugKey(p.label)));
  if (taken.size >= 10 || !left.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-3">
      <span className="mr-1 text-xs text-muted">Quick add</span>
      {left.slice(0, 8).map((p) => (
        <button key={p.label} type="button" onClick={() => onAdd(p)} className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-2.5 text-xs font-medium transition-colors hover:border-border-strong hover:bg-surface-2 touch:h-8">
          <Plus className="size-3 text-subtle" />
          {p.label}
        </button>
      ))}
    </div>
  );
}

/** A reasonable kind for a field from its name ("Renewal date" → date). */
function guessKind(label: string): FieldKind {
  const l = label.toLowerCase();
  if (/\b(date|deadline|expir|renew|due|until|since|end|start)/.test(l)) return 'date';
  if (/\b(cost|price|amount|fee|budget|spend)/.test(l)) return 'currency';
  if (/\b(count|seats|qty|quantity|number of|months|days|years)\b/.test(l)) return 'number';
  if (/\b(email|e-mail)\b/.test(l)) return 'email';
  if (/\b(url|link|website|portal|site)\b/.test(l)) return 'url';
  if (/\b(owner|contact|manager|assignee|approver|person|user)\b/.test(l)) return 'user';
  if (/\b(key|password|pin|token|secret)\b/.test(l)) return 'secret';
  if (/\b(notes|description|comments)\b/.test(l)) return 'longText';
  if (/^(is|has|needs|auto)\b|\?$/.test(l)) return 'boolean';
  return 'text';
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
          <span className="block truncate text-xs text-subtle">{fieldKindMeta[field.kind].label}{field.description ? ` · ${field.description}` : ''}</span>
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

/** A template field shown in a team variant: visible for context, changed only on the template. */
function LockedFieldRow({ field, from }: { field: FieldDefinition; from: string }) {
  const Icon = kindIcons[field.kind];
  return (
    <li className="flex items-center gap-3 bg-surface-2/40 px-2 py-2 pl-9 text-muted">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{field.label}</span>
        <span className="block truncate text-[11px] text-subtle">from {from}</span>
      </span>
      <Lock className="size-3.5 shrink-0 text-subtle" aria-label="Defined by the template" />
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
  onDone,
  plain = false,
}: {
  /** Inside a drawer: no card or header (the drawer has its own). */
  plain?: boolean;
  field: FieldDefinition;
  fields: FieldDefinition[];
  sections: string[];
  kinds: DateKind[];
  keyLocked: boolean;
  onChange: (f: FieldDefinition) => void;
  onRemove: () => void;
  onDone?: () => void;
}) {
  const [autoKey, setAutoKey] = useState(!keyLocked);
  const set = (patch: Partial<FieldDefinition>) => onChange({ ...field, ...patch } as FieldDefinition);
  const setConfig = (patch: Record<string, unknown>) => onChange({ ...field, config: { ...field.config, ...patch } } as FieldDefinition);
  const Icon = kindIcons[field.kind];
  // Text limits are rarely needed; everything else of a kind is part of setting it up.
  const kindIsAdvanced = field.kind === 'text';

  const header = (
    <div className="flex items-center gap-2 border-b border-border px-4 py-3">
      <span className="flex size-7 items-center justify-center rounded-md bg-surface-2 text-muted">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold">{field.label || 'Untitled field'}</p>
        <p className="text-xs text-muted">{fieldKindMeta[field.kind].label}</p>
      </div>
      <Button size="icon" variant="danger-ghost" aria-label="Remove field" icon={<Trash2 className="size-4" />} onClick={onRemove} />
      {onDone && (
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      )}
    </div>
  );
  const body = (
    <div className={cn('space-y-4', !plain && 'p-4')}>
      <Field label="Name on the form">
        {(id) => <Input id={id} value={field.label} autoFocus={!plain && !field.label} onChange={(e) => set({ label: e.target.value, ...(autoKey && { key: slugKey(e.target.value) }) })} />}
      </Field>
      {!kindIsAdvanced && <KindConfig field={field} fields={fields} kinds={kinds} setConfig={setConfig} />}
      <div className="space-y-2.5 rounded-lg bg-surface-2/60 p-3">
        <Switch checked={field.required} onChange={(required) => set({ required })} label="Required" description="Items cannot be saved without it" />
        <Switch checked={field.showInTable} onChange={(showInTable) => set({ showInTable })} label="Show as a table column" description="People can still add or hide columns themselves" />
      </div>
      {sections.length > 0 && (
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
      )}
      <details className="group rounded-lg border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[13px] font-medium select-none">
          More options
          <ChevronDown className="size-4 text-subtle transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-4 border-t border-border p-3">
          <Field label="Help text" hint="Shown under the field on the form">
            {(id) => <Input id={id} value={field.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} />}
          </Field>
          <Switch
            checked={field.restricted || field.kind === 'secret'}
            disabled={field.kind === 'secret'}
            onChange={(restricted) => set({ restricted })}
            label="Restricted"
            description="Only people with the “See secrets” permission can see or change it; never searchable"
          />
          {kindIsAdvanced && <KindConfig field={field} fields={fields} kinds={kinds} setConfig={setConfig} />}
          <Field label="Key" hint={keyLocked ? 'Items already use it, so it cannot change' : 'Used in imports, exports and integrations'}>
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
      </details>
    </div>
  );
  return plain ? (
    body
  ) : (
    <Card padded={false}>
      {header}
      {body}
    </Card>
  );
}

const listPresets = [
  { key: 'any', label: 'Any text', pattern: undefined, placeholder: undefined },
  { key: 'mac', label: 'MAC address (AA:BB:CC:DD:EE:FF)', pattern: '^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$', placeholder: 'AA:BB:CC:DD:EE:FF' },
  { key: 'ipv4', label: 'IPv4 address', pattern: '^((25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1?\\d?\\d)$', placeholder: '10.0.0.12' },
  { key: 'host', label: 'Hostname', pattern: '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$', placeholder: 'lab-ws-07.corp.example.com' },
  { key: 'email', label: 'Email address', pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', placeholder: 'name@example.com' },
];

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
      return (
        <div className="space-y-3">
          <Field label="Linked asset type">{(id) => <AssetTypeSelect id={id} includeAll allLabel="Any type" value={field.config.assetTypeId ?? null} onChange={(v) => setConfig({ assetTypeId: v ?? undefined })} />}</Field>
          <Checkbox checked={field.config.multiple} onChange={(multiple) => setConfig({ multiple })} label="Several items (e.g. the machines that use this license)" />
        </div>
      );
    case 'list': {
      const preset = listPresets.find((x) => x.pattern === field.config.pattern)?.key ?? (field.config.pattern ? 'custom' : 'any');
      return (
        <div className="space-y-3">
          <Field label="Each entry is" hint="Checked on every entry, also on import">
            {(id) => (
              <Select id={id} value={preset} onChange={(e) => {
                const x = listPresets.find((p) => p.key === e.target.value);
                setConfig({ pattern: e.target.value === 'custom' ? (field.config.pattern ?? '') : x?.pattern, placeholder: x?.placeholder });
              }}>
                {listPresets.map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                  </option>
                ))}
                <option value="custom">Custom format (regex)…</option>
              </Select>
            )}
          </Field>
          {preset === 'custom' && (
            <Field label="Pattern (regex)">{(id) => <Input id={id} className="font-mono text-xs" value={field.config.pattern ?? ''} onChange={(e) => setConfig({ pattern: e.target.value || undefined })} />}</Field>
          )}
          <Field label="At most">{(id) => <Input id={id} type="number" min={1} max={1000} className="w-28" value={field.config.maxItems} onChange={(e) => setConfig({ maxItems: Math.max(1, Number(e.target.value) || 1) })} />}</Field>
        </div>
      );
    }
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

  return (
    <div className="space-y-4 rounded-xl border border-border p-3">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 text-accent" />
        <p className="text-[13px] font-semibold">What is this date?</p>
      </div>
      <Select
        value={t?.dateKindId ?? ''}
        onChange={(e) => onChange(e.target.value ? { dateKindId: e.target.value, notify: t?.notify ?? { owner: true, userFields: [], emails: [], unitManagers: 'fallback' }, derive: t?.derive, recurrence: t?.recurrence, reminders: t?.reminders, confirmBefore: t?.confirmBefore ?? null } : undefined)}
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
              {kind.behavior === 'recurring' && (
                <Field
                  label="Ask the owner first"
                  hint="Before each renewal, the owner is asked whether to renew as is, renew with changes, or not renew. Buyers see the answer next to the date."
                  aside={<Switch checked={!!t.confirmBefore} onChange={(c) => set({ confirmBefore: c ? { amount: 60, unit: 'day' } : null })} />}
                >
                  {() =>
                    t.confirmBefore ? (
                      <div className="flex items-center gap-2 text-[13px]">
                        <DurationInput value={t.confirmBefore} onChange={(confirmBefore) => set({ confirmBefore })} />
                        <span className="text-muted">before the date</span>
                      </div>
                    ) : (
                      <p className="text-xs text-muted">Off — anyone handling the renewal can still ask with one click.</p>
                    )
                  }
                </Field>
              )}
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
                    <TagInput
                      value={t.notify.emails}
                      onChange={(emails) => set({ notify: { ...t.notify, emails: emails.map((e) => e.toLowerCase()) } })}
                      validate={(v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)}
                      placeholder="Also email, e.g. procurement@corp.com"
                    />
                    <Select
                      value={t.notify.unitManagers}
                      onChange={(e) => set({ notify: { ...t.notify, unitManagers: e.target.value as 'never' | 'fallback' | 'always' } })}
                    >
                      <option value="fallback">Team managers — only if nobody else would be told</option>
                      <option value="always">Team managers — always</option>
                      <option value="never">Team managers — never</option>
                    </Select>
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
        <h2 className="text-[13px] font-semibold">Item statuses</h2>
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

/** The form people will fill in, with the same inputs as the real one. `onPick` makes a field's label select it for editing. */
function FormBody({ draft, kinds, onPick }: { draft: Pick<AssetTypeInput, 'fields' | 'sections'>; kinds: DateKind[]; onPick?: (id: string) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const grouped = useMemo(() => {
    const out = new Map<string, FieldDefinition[]>();
    for (const f of draft.fields) out.set(f.section ?? '', [...(out.get(f.section ?? '') ?? []), f]);
    return [...out.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : draft.sections.indexOf(a) - draft.sections.indexOf(b)));
  }, [draft.fields, draft.sections]);
  if (!draft.fields.length) return <p className="text-[13px] text-muted">Add fields to see the form here.</p>;
  return (
    <div className="space-y-6">
      {grouped.map(([section, fields]) => (
        <fieldset key={section || '_'}>
          {section && <legend className="mb-3 text-xs font-semibold tracking-wide text-subtle uppercase">{section}</legend>}
          <div className="grid grid-cols-2 gap-4">
            {fields.map((f) => {
              const t = f.kind === 'date' ? f.config.tracking : undefined;
              const k = t && kinds.find((x) => x.id === t.dateKindId);
              return (
                <div
                  key={f.id}
                  className={cn(f.kind === 'longText' || f.kind === 'multiSelect' || f.kind === 'list' ? 'col-span-2' : 'max-sm:col-span-2', onPick && '-m-1.5 cursor-pointer rounded-lg p-1.5 transition-colors hover:bg-surface-2/70')}
                  onClick={onPick ? (e) => !(e.target as HTMLElement).closest('input,select,textarea,button,[role=combobox]') && onPick(f.id) : undefined}
                  title={onPick ? 'Click to edit this field' : undefined}
                >
                  <Field label={f.kind === 'boolean' ? '' : f.label} required={f.required} hint={k ? `${k.name}${t?.derive ? ' · calculated' : ''}` : f.description}>
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
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

/** Beside the field list on wide screens: the form as it will look, updating as you edit. */
function LivePreview({ draft, kinds, onPick }: { draft: Pick<AssetTypeInput, 'name' | 'fields' | 'sections'>; kinds: DateKind[]; onPick: (id: string) => void }) {
  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Eye className="size-4 text-subtle" />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">New {inSentence(draft.name) || 'item'}</p>
          <p className="text-xs text-muted">Live preview · click a field to edit it</p>
        </div>
      </div>
      <div className="max-h-[calc(100dvh-12rem)] overflow-y-auto p-4">
        <FormBody draft={draft} kinds={kinds} onPick={onPick} />
      </div>
    </Card>
  );
}

function FormPreview({ open, onOpenChange, draft, kinds }: { open: boolean; onOpenChange: (o: boolean) => void; draft: Pick<AssetTypeInput, 'name' | 'fields' | 'sections'>; kinds: DateKind[] }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`New ${inSentence(draft.name) || 'item'}`} description="Preview — nothing is saved">
      <FormBody draft={draft} kinds={kinds} />
    </Sheet>
  );
}

/** Purchases and renewals of this template follow the organization's workflow, or one of its own. */
function RequestWorkflowCard({ value, saved, onChange }: { value: Workflow | null; saved: Workflow | null; onChange: (w: Workflow | null) => void }) {
  const org = useOrgWorkflow();
  return (
    <Card className="space-y-3">
      <SectionTitle>Requests</SectionTitle>
      <Switch
        checked={!!value}
        onChange={(own) => onChange(own ? structuredClone(org.data ?? defaultWorkflow) : null)}
        label="Own request workflow"
        description={value ? 'Purchases and renewals of this template go through these statuses.' : <>Requests follow the organization’s workflow: {(org.data?.statuses ?? []).map((s) => s.label).join(' → ')}.</>}
      />
      {value && <WorkflowEditor value={value} onChange={onChange} lockedKeys={saved?.statuses.map((s) => s.key)} />}
    </Card>
  );
}

