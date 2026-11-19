import { computeDerivedDates, effectivePermissions, isRestricted, type Asset, type AssetType, type Attributes, type Catalog, type Duration, type FieldDefinition, type PurchaseRequest } from '@am/core';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Lock, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useInvalidateAssets, useLookups, useMe } from '@/lib/queries';
import { formatDate, formatDurations } from '@/lib/utils';
import { AttributeInput } from './attribute';
import { DurationListEditor } from './duration-editor';
import { CatalogSelect } from './catalogs';
import { PersonPicker, UnitPicker } from './pickers';
import { useMyOrg } from '@/lib/org';
import { Button } from './ui/button';
import { Field, Input, Select, Switch } from './ui/form';
import { Sheet } from './ui/overlay';

interface Draft {
  name: string;
  status: string;
  ownerId: string | null;
  unitId: string | null;
  catalogId: string | null;
  attributes: Record<string, unknown>;
  reminderOverrides: Record<string, Duration[]>;
}

const fromAsset = (type: AssetType, a: Asset | null, me: string | undefined, defaultUnit: string | null, request?: PurchaseRequest | null, catalog?: Catalog | null): Draft => ({
  name: a?.name ?? request?.title ?? '',
  status: a?.status ?? type.statuses[0]!.value,
  ownerId: a?.ownerId ?? request?.requesterId ?? me ?? null,
  unitId: a?.unitId ?? request?.unitId ?? defaultUnit,
  catalogId: a ? a.catalogId : (catalog?.id ?? null),
  attributes: { ...(a?.attributes ?? {}) },
  reminderOverrides: { ...(a?.reminderOverrides ?? {}) },
});

/**
 * Create and edit share this form; it is generated entirely from the asset
 * type. With `request`, it fulfils that request (pre-filled, and closes it on save).
 */
export function AssetFormSheet({
  open,
  onOpenChange,
  type,
  asset,
  request,
  catalog,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  type: AssetType;
  asset?: Asset | null;
  request?: PurchaseRequest | null;
  /** Creating from a catalog page: filed there, in one of the catalog's teams. */
  catalog?: Catalog | null;
}) {
  const me = useMe().data;
  const { kindById, unitById } = useLookups();
  const { mine, can } = useMyOrg();
  const navigate = useNavigate();
  const invalidate = useInvalidateAssets();
  // A catalog shared with me at edit lets me add items to its unit's teams, even outside my own.
  const inCatalog = (unitId: string) => !!catalog && catalog.permissions.includes('create') && !!unitById.get(unitId)?.path.includes(catalog.unitId);
  const teamAllowed = (unitId: string) => (asset ? can(unitId, 'edit', type.id) || unitId === asset.unitId : can(unitId, 'create', type.id)) || inCatalog(unitId);
  const defaultUnit = catalog
    ? (mine.find((m) => m.unit.path.includes(catalog.unitId) && teamAllowed(m.unit.id))?.unit.id ?? catalog.unitId)
    : (mine.find((m) => can(m.unit.id, 'create', type.id))?.unit.id ?? null);
  const [draft, setDraft] = useState<Draft>(() => fromAsset(type, asset ?? null, me?.userId, defaultUnit, request, catalog));
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setDraft(fromAsset(type, asset ?? null, me?.userId, defaultUnit, request, catalog));
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asset?.id, type.id, request?.id]);

  const unit = draft.unitId ? unitById.get(draft.unitId) : undefined;
  const canRestricted = asset ? asset.permissions.includes('restricted') : !!me && !!unit && effectivePermissions(me, { unitPath: unit.path, assetTypeId: type.id }).has('restricted');
  const derived = useMemo(() => computeDerivedDates(type.fields, draft.attributes as Attributes), [type.fields, draft.attributes]);

  const sections = useMemo(() => {
    const groups = new Map<string, FieldDefinition[]>();
    for (const f of type.fields) {
      const key = f.section ?? '';
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : type.sections.indexOf(a) - type.sections.indexOf(b)));
  }, [type]);

  const save = useMutation({
    mutationFn: () => {
      const attributes = Object.fromEntries(Object.entries(draft.attributes).filter(([k]) => canRestricted || !isRestricted(type.fields.find((f) => f.key === k)!)));
      const body = { name: draft.name, status: draft.status, ownerId: draft.ownerId, unitId: draft.unitId, catalogId: draft.catalogId, attributes, reminderOverrides: draft.reminderOverrides };
      return asset
        ? api.patch<Asset>(`/api/registry/assets/${asset.id}`, body)
        : api.post<Asset>('/api/registry/assets', { ...body, assetTypeId: type.id, ...(request && { requestId: request.id }) });
    },
    onSuccess: (saved) => {
      toast.success(asset ? 'Saved' : request ? `${request.number} fulfilled` : `${type.name} created`);
      invalidate(saved.id);
      onOpenChange(false);
      if (!asset) void navigate({ to: '/assets/$assetId', params: { assetId: saved.id } });
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        toast.error(e.message);
      } else toast.error('Save failed');
    },
  });

  const setAttr = (key: string, v: unknown) => setDraft((d) => ({ ...d, attributes: { ...d.attributes, [key]: v } }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={asset ? `Edit ${asset.name}` : request ? `Fulfil ${request.number}` : `New ${type.name.toLowerCase()}`}
      description={request ? `Creates the ${type.name.toLowerCase()} and closes “${request.title}”.` : type.description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="asset-form" loading={save.isPending} disabled={!draft.name || !draft.unitId}>
            {asset ? 'Save changes' : request ? 'Create & fulfil' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="asset-form" onSubmit={submit} className="space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" required className="col-span-2">
            {(id) => <Input id={id} autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={`e.g. ${type.name} for …`} />}
          </Field>
          <Field label="Team" required hint="Who it's for. Its people can see it; access follows the org chart.">
            {(id) => <UnitPicker id={id} value={draft.unitId} onChange={(v) => setDraft({ ...draft, unitId: v })} filter={(u) => teamAllowed(u.id)} />}
          </Field>
          <Field label="Status">
            {(id) => (
              <Select id={id} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                {type.statuses.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {unit && (
            <Field label="Catalog" className="col-span-2" hint="Everyone the catalog is shared with can see this item.">
              {(id) => <CatalogSelect id={id} value={draft.catalogId} unitPath={unit.path} onChange={(catalogId) => setDraft({ ...draft, catalogId })} />}
            </Field>
          )}
          <Field label="Owner" className="col-span-2" hint="Receives reminders unless a date says otherwise">
            {(id) => <PersonPicker id={id} value={draft.ownerId} onChange={(v) => setDraft({ ...draft, ownerId: v })} />}
          </Field>
        </div>

        {sections.map(([section, fields]) => (
          <fieldset key={section || '_'} className="space-y-4">
            {section && <legend className="mb-3 text-xs font-semibold tracking-wide text-subtle uppercase">{section}</legend>}
            <div className="grid grid-cols-2 gap-4">
              {fields.map((f) => {
                const restricted = isRestricted(f);
                if (restricted && !canRestricted) {
                  return (
                    <Field key={f.key} label={f.label} className="col-span-2 sm:col-span-1">
                      {() => (
                        <div className="flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 text-xs text-subtle">
                          <Lock className="size-3" /> Managers only
                        </div>
                      )}
                    </Field>
                  );
                }
                const tracking = f.kind === 'date' ? f.config.tracking : undefined;
                const kind = tracking && kindById.get(tracking.dateKindId);
                const wide = f.kind === 'longText' || f.kind === 'multiSelect' || f.kind === 'user';
                if (tracking?.derive) {
                  const value = derived[f.key] as string | undefined;
                  return (
                    <Field key={f.key} label={f.label} className="col-span-2 sm:col-span-1" hint={`Calculated from ${type.fields.find((x) => x.key === tracking.derive!.from)?.label ?? tracking.derive.from}`}>
                      {() => (
                        <div className="flex h-8 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-[13px]">
                          <Sparkles className="size-3.5 text-accent" />
                          {value ? formatDate(value) : <span className="text-subtle">—</span>}
                        </div>
                      )}
                    </Field>
                  );
                }
                return (
                  <Field
                    key={f.key}
                    label={f.kind === 'boolean' ? '' : f.label}
                    required={f.required}
                    error={errors[f.key]}
                    hint={kind ? `${kind.name} · ${formatDurations(draft.reminderOverrides[f.key] ?? tracking!.reminders ?? kind.defaultReminders)}` : f.description}
                    className={wide ? 'col-span-2' : 'col-span-2 sm:col-span-1'}
                    aside={restricted ? <Lock className="size-3 text-subtle" /> : undefined}
                  >
                    {(id) => <AttributeInput id={id} field={f} value={draft.attributes[f.key]} onChange={(v) => setAttr(f.key, v)} invalid={!!errors[f.key]} />}
                  </Field>
                );
              })}
            </div>
          </fieldset>
        ))}

        <ReminderOverrides type={type} value={draft.reminderOverrides} onChange={(reminderOverrides) => setDraft({ ...draft, reminderOverrides })} />
      </form>
    </Sheet>
  );
}

/** Per-asset reminder schedule, for when one contract needs more lead time than its template. */
function ReminderOverrides({ type, value, onChange }: { type: AssetType; value: Record<string, Duration[]>; onChange: (v: Record<string, Duration[]>) => void }) {
  const { kindById } = useLookups();
  const tracked = type.fields.filter((f) => f.kind === 'date' && f.config.tracking && kindById.get(f.config.tracking.dateKindId)?.behavior !== 'informational');
  if (!tracked.length) return null;
  return (
    <fieldset className="space-y-3 rounded-xl border border-border p-4">
      <legend className="px-1 text-xs font-semibold tracking-wide text-subtle uppercase">Reminders for this asset</legend>
      {tracked.map((f) => {
        if (f.kind !== 'date') return null;
        const t = f.config.tracking!;
        const kind = kindById.get(t.dateKindId);
        const custom = f.key in value;
        return (
          <div key={f.key} className="space-y-2">
            <Switch
              checked={custom}
              label={f.label}
              description={custom ? 'Custom schedule for this asset' : `Template default: ${formatDurations(t.reminders ?? kind?.defaultReminders ?? [])}`}
              onChange={(on) => {
                const next = { ...value };
                if (on) next[f.key] = t.reminders ?? kind?.defaultReminders ?? [];
                else delete next[f.key];
                onChange(next);
              }}
            />
            {custom && <DurationListEditor value={value[f.key]!} onChange={(v) => onChange({ ...value, [f.key]: v })} />}
          </div>
        );
      })}
    </fieldset>
  );
}
