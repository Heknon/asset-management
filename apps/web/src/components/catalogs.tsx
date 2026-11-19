import { unitPermissions, type Catalog, type CatalogShare, type Permission, type Subject } from '@am/core';
import { AccessEditor, accessLabel, SubjectIcon } from './access';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { keys, useCatalogs, useLookups, useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { ColorPicker, IconPicker, UnitPath, UnitPicker } from './pickers';
import { TypeIcon } from './type-icon';
import { Button } from './ui/button';
import { Badge, Card } from './ui/display';
import { Field, Input, Select, Textarea } from './ui/form';
import { Dialog } from './ui/overlay';


const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Something went wrong');

function useInvalidateCatalogs() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.catalogs });
    void qc.invalidateQueries({ queryKey: keys.assets });
    setTimeout(() => void qc.invalidateQueries({ queryKey: keys.obligations }), 1500);
  };
}

/** Units where I can create catalogs: those I manage (directly, or above them). */
export function useManageableUnits() {
  const me = useMe().data;
  const { units } = useLookups();
  return units.filter((u) => !u.archived && me && unitPermissions(me, u.path).has('manage'));
}

export function CatalogCard({ catalog }: { catalog: Catalog }) {
  return (
    <Link to="/catalogs/$catalogId" params={{ catalogId: catalog.id }} className="block">
      <Card className="flex h-full flex-col gap-2 transition-colors hover:border-border-strong">
        <div className="flex items-start gap-3">
          <TypeIcon icon={catalog.icon} color={catalog.color} size={34} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold">{catalog.name}</p>
            <p className="truncate text-xs text-muted">
              <UnitPath id={catalog.unitId} />
            </p>
          </div>
          {catalog.sharedWithMe && <Badge tone="accent">{accessLabel(catalog.permissions)}</Badge>}
        </div>
        {catalog.description && <p className="line-clamp-2 text-xs text-muted">{catalog.description}</p>}
        <div className="mt-auto flex items-center gap-3 pt-1 text-xs text-subtle">
          <span>
            {catalog.assetCount} {catalog.assetCount === 1 ? 'item' : 'items'}
          </span>
          {catalog.shares.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Share2 className="size-3" />
              Shared with {catalog.shares.length}
            </span>
          )}
        </div>
      </Card>
    </Link>
  );
}

/** Create (with a unit) or edit a catalog. */
export function CatalogFormDialog({ open, onOpenChange, catalog, unitId, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; catalog?: Catalog; unitId?: string; onSaved?: (c: Catalog) => void }) {
  const manageable = useManageableUnits();
  const invalidate = useInvalidateCatalogs();
  const blank = { unitId: unitId ?? manageable[0]?.id ?? null, name: '', description: '', icon: 'folder', color: '#6366f1' };
  const [draft, setDraft] = useState(blank);
  useEffect(() => {
    if (open) setDraft(catalog ? { unitId: catalog.unitId, name: catalog.name, description: catalog.description ?? '', icon: catalog.icon, color: catalog.color } : blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalog?.id]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: draft.name, description: draft.description.trim() || null, icon: draft.icon, color: draft.color };
      return catalog ? api.put<Catalog>(`/api/registry/catalogs/${catalog.id}`, body) : api.post<Catalog>('/api/registry/catalogs', { ...body, unitId: draft.unitId });
    },
    onSuccess: (c) => {
      toast.success(catalog ? 'Saved' : `Created “${c.name}”`, catalog ? undefined : { description: 'Add assets to it, then share it with other teams.' });
      invalidate();
      onOpenChange(false);
      onSaved?.(c);
    },
    onError,
  });

  const ids = new Set(manageable.map((u) => u.id));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={catalog ? 'Edit catalog' : 'New catalog'}
      description="A collection of your unit's assets — licenses, lab equipment, tools — that you can share with other teams."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!draft.name.trim() || !draft.unitId} loading={save.isPending} onClick={() => save.mutate()}>
            {catalog ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          {(id) => <Input id={id} autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. R&D Labs, Design licenses" />}
        </Field>
        {!catalog && (
          <Field label="Owned by" required hint="It can hold assets of this unit and every team beneath it. Its managers decide who it is shared with.">
            {(id) => <UnitPicker id={id} value={draft.unitId} onChange={(v) => setDraft({ ...draft, unitId: v })} filter={(u) => ids.has(u.id)} />}
          </Field>
        )}
        <Field label="Description">{(id) => <Textarea id={id} rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What is in it, who it is for" />}</Field>
        <Field label="Look">
          {() => (
            <div className="space-y-2">
              <ColorPicker value={draft.color} onChange={(color) => setDraft({ ...draft, color })} />
              <IconPicker value={draft.icon} color={draft.color} onChange={(icon) => setDraft({ ...draft, icon })} />
            </div>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

/** Who a catalog is shared with, and adding/removing/changing shares. */
export function ShareDialog({ catalog, open, onOpenChange }: { catalog: Catalog; open: boolean; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateCatalogs();
  const canManage = catalog.permissions.includes('manage');
  const put = useMutation({
    mutationFn: ({ subject, permissions }: { subject: Pick<Subject, 'kind' | 'id'>; permissions: Permission[] }) =>
      api.post<Catalog>(`/api/registry/catalogs/${catalog.id}/shares`, { subject: { kind: subject.kind, id: subject.id }, access: { role: 'custom', permissions } }),
    onSuccess: invalidate,
    onError,
  });
  const remove = useMutation({
    mutationFn: (s: CatalogShare) => api.delete<Catalog>(`/api/registry/catalogs/${catalog.id}/shares/${s.subject.kind}/${s.subject.id}`),
    onSuccess: invalidate,
    onError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Share “${catalog.name}”`} description="Everyone you add gets access to everything in this catalog, including items added later." footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}>
      <AccessEditor
        canManage={canManage}
        pending={put.isPending}
        entries={catalog.shares.map((s) => ({ key: `${s.subject.kind}:${s.subject.id}`, subject: s.subject, permissions: s.permissions, note: `shared by ${s.createdByName}` }))}
        onAdd={(subject, permissions) => put.mutate({ subject, permissions })}
        onChange={(e, permissions) => put.mutate({ subject: e.subject, permissions })}
        onRemove={(e) => remove.mutate(catalog.shares.find((s) => `${s.subject.kind}:${s.subject.id}` === e.key)!)}
        inherited={
          <div className="flex items-center gap-2.5 rounded-lg bg-surface-2/60 px-3 py-2 text-[13px]">
            <SubjectIcon kind="unit" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">
                <UnitPath id={catalog.unitId} />
              </span>
              <span className="block text-xs text-muted">Owner · its people keep the access the organization chart gives them</span>
            </span>
          </div>
        }
      />
    </Dialog>
  );
}

/** Catalogs an asset in `unitPath` can be filed in (those I can edit). */
export function CatalogSelect({ id, value, unitPath, onChange }: { id?: string; value: string | null; unitPath: string[]; onChange: (v: string | null) => void }) {
  const catalogs = useCatalogs();
  const options = (catalogs.data ?? []).filter((c) => unitPath.includes(c.unitId) && (c.permissions.includes('edit') || c.id === value));
  if (!options.length && !value) return <p className="text-xs text-muted">No catalogs for this team yet.</p>;
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className={cn(!value && 'text-muted')}>
      <option value="">Not in a catalog</option>
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
          {c.shares.length ? ` · shared with ${c.shares.length}` : ''}
        </option>
      ))}
    </Select>
  );
}
