import { atLeast, unitLevel, type Catalog, type CatalogShare } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Building2, Share2, Trash2, User, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { keys, useCatalogs, useLookups, useMe, usePeople } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { ColorPicker, IconPicker, PersonPicker, UnitPath, UnitPicker } from './pickers';
import { TypeIcon } from './type-icon';
import { Button } from './ui/button';
import { Badge, Card } from './ui/display';
import { Field, Input, Segmented, Select, Textarea } from './ui/form';
import { Dialog } from './ui/overlay';

export const levelLabel = { view: 'Can view', edit: 'Can edit' } as const;

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
  return units.filter((u) => !u.archived && me && atLeast(unitLevel(me, u.path), 'manage'));
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
          {catalog.sharedWithMe && <Badge tone="accent">{levelLabel[catalog.access === 'edit' ? 'edit' : 'view']}</Badge>}
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
  const { unitById } = useLookups();
  const people = usePeople(catalog.shares.filter((s) => s.subjectKind === 'user').map((s) => s.subjectId));
  const [kind, setKind] = useState<'unit' | 'user'>('unit');
  const [subject, setSubject] = useState<string | null>(null);
  const [level, setLevel] = useState<'view' | 'edit'>('view');
  const canManage = catalog.access === 'manage';

  const put = useMutation({
    mutationFn: (s: Pick<CatalogShare, 'subjectKind' | 'subjectId' | 'level'>) => api.post<Catalog>(`/api/registry/catalogs/${catalog.id}/shares`, s),
    onSuccess: () => (setSubject(null), invalidate()),
    onError,
  });
  const remove = useMutation({
    mutationFn: (s: Pick<CatalogShare, 'subjectKind' | 'subjectId'>) => api.delete<Catalog>(`/api/registry/catalogs/${catalog.id}/shares/${s.subjectKind}/${s.subjectId}`),
    onSuccess: invalidate,
    onError,
  });
  const nameOf = (s: CatalogShare) => (s.subjectKind === 'unit' ? (unitById.get(s.subjectId)?.name ?? 'Unknown unit') : (people.get(s.subjectId)?.displayName ?? '…'));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Share “${catalog.name}”`} description="Everyone you share with sees everything in this catalog, including items added later." footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}>
      <div className="space-y-5 text-[13px]">
        {canManage && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <Segmented
              value={kind}
              onChange={(k) => (setKind(k), setSubject(null))}
              options={[
                { value: 'unit', label: 'Team, department or division' },
                { value: 'user', label: 'Person' },
              ]}
            />
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-56 flex-1">
                {kind === 'unit' ? (
                  <UnitPicker value={subject} onChange={setSubject} placeholder="Choose a unit" filter={(u) => !u.archived && !catalog.shares.some((s) => s.subjectId === u.id)} />
                ) : (
                  <PersonPicker value={subject} onChange={setSubject} placeholder="Choose a person" />
                )}
              </div>
              <Select className="w-32" value={level} onChange={(e) => setLevel(e.target.value as 'view' | 'edit')} aria-label="Access">
                <option value="view">{levelLabel.view}</option>
                <option value="edit">{levelLabel.edit}</option>
              </Select>
              <Button variant="primary" disabled={!subject} loading={put.isPending} onClick={() => subject && put.mutate({ subjectKind: kind, subjectId: subject, level })}>
                Share
              </Button>
            </div>
            <p className="text-xs text-muted">
              {kind === 'unit' ? 'Sharing with a unit includes every team beneath it. ' : ''}
              “Can edit” lets them update items and their documents and add new items here; only your unit’s managers can delete, see restricted fields or share further.
            </p>
          </div>
        )}

        <div>
          <p className="mb-2 text-xs font-medium text-subtle">Has access</p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            <li className="flex items-center gap-2.5 px-3 py-2">
              <Building2 className="size-4 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">
                  <UnitPath id={catalog.unitId} />
                </span>
                <span className="block text-xs text-muted">Owner · access from the organization chart</span>
              </span>
            </li>
            {catalog.shares.map((s) => (
              <li key={`${s.subjectKind}:${s.subjectId}`} className="flex items-center gap-2.5 px-3 py-2">
                {s.subjectKind === 'unit' ? <Users className="size-4 text-muted" /> : <User className="size-4 text-muted" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.subjectKind === 'unit' ? <UnitPath id={s.subjectId} /> : nameOf(s)}</span>
                  <span className="block text-xs text-muted">
                    {s.subjectKind === 'unit' ? 'Everyone in it' : 'Person'} · shared by {s.createdByName}
                  </span>
                </span>
                {canManage ? (
                  <>
                    <Select className="w-28" value={s.level} onChange={(e) => put.mutate({ subjectKind: s.subjectKind, subjectId: s.subjectId, level: e.target.value as 'view' | 'edit' })} aria-label={`Access for ${nameOf(s)}`}>
                      <option value="view">{levelLabel.view}</option>
                      <option value="edit">{levelLabel.edit}</option>
                    </Select>
                    <Button size="icon" variant="ghost" aria-label={`Stop sharing with ${nameOf(s)}`} icon={<Trash2 className="size-3.5" />} onClick={() => remove.mutate(s)} />
                  </>
                ) : (
                  <Badge>{levelLabel[s.level]}</Badge>
                )}
              </li>
            ))}
          </ul>
          {!catalog.shares.length && <p className="mt-2 text-xs text-muted">Not shared yet — only its own unit can see it.</p>}
        </div>
      </div>
    </Dialog>
  );
}

/** Catalogs an asset in `unitPath` can be filed in (those I can edit). */
export function CatalogSelect({ id, value, unitPath, onChange }: { id?: string; value: string | null; unitPath: string[]; onChange: (v: string | null) => void }) {
  const catalogs = useCatalogs();
  const options = (catalogs.data ?? []).filter((c) => unitPath.includes(c.unitId) && (atLeast(c.access, 'edit') || c.id === value));
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
