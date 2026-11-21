import { unitPermissions, type Catalog, type CatalogShare, type Permission, type Subject } from '@am/core';
import { AccessEditor, accessLabel, SubjectIcon } from './access';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { keys, useCatalogs, useLookups, useMe } from '@/lib/queries';
import { plural, t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ColorPicker, IconPicker, triggerClass, UnitPath, UnitPicker } from './pickers';
import { TypeIcon } from './type-icon';
import { Button } from './ui/button';
import { Badge, Card } from './ui/display';
import { Field, Input, Select, Textarea } from './ui/form';
import { Dialog, Popover } from './ui/overlay';


const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('Something went wrong'));

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
          <span>{plural(catalog.assetCount, '{n} item', '{n} items')}</span>
          {catalog.shares.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Share2 className="size-3" />
              {t('Shared with {count}', { count: catalog.shares.length })}
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
      toast.success(catalog ? t('Saved') : t('Created “{name}”', { name: c.name }), catalog ? undefined : { description: t('Add assets to it, then share it with other teams.') });
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
      title={catalog ? t('Edit catalog') : t('New catalog')}
      description={t("A collection of your unit's assets — licenses, lab equipment, tools — that you can share with other teams.")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!draft.name.trim() || !draft.unitId} loading={save.isPending} onClick={() => save.mutate()}>
            {catalog ? t('Save') : t('Create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('Name')} required>
          {(id) => <Input id={id} autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t('e.g. R&D Labs, Design licenses')} />}
        </Field>
        {!catalog && (
          <Field label={t('Owned by')} required hint={t('It can hold assets of this unit and every team beneath it. Its managers decide who it is shared with.')}>
            {(id) => <UnitPicker id={id} value={draft.unitId} onChange={(v) => setDraft({ ...draft, unitId: v })} filter={(u) => ids.has(u.id)} />}
          </Field>
        )}
        <Field label={t('Description')}>{(id) => <Textarea id={id} rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={t('What is in it, who it is for')} />}</Field>
        <Field label={t('Look')}>
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
    <Dialog open={open} onOpenChange={onOpenChange} title={t('Share “{name}”', { name: catalog.name })} description={t('Everyone you add gets access to everything in this catalog, including items added later.')} footer={<Button onClick={() => onOpenChange(false)}>{t('Done')}</Button>}>
      <AccessEditor
        canManage={canManage}
        pending={put.isPending}
        entries={catalog.shares.map((s) => ({ key: `${s.subject.kind}:${s.subject.id}`, subject: s.subject, permissions: s.permissions, note: t('shared by {name}', { name: s.createdByName }) }))}
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
              <span className="block text-xs text-muted">{t('Owner · its people keep the access the organization chart gives them')}</span>
            </span>
          </div>
        }
      />
    </Dialog>
  );
}

/** Catalogs an asset in `unitPath` can be filed in (those I can edit). */
/**
 * Which catalog an item is filed in. Searchable (there can be many): by the
 * catalog's name or its team's path. Phones get a sheet with the search on top.
 */
export function CatalogSelect({ id, value, unitPath, onChange }: { id?: string; value: string | null; unitPath: string[]; onChange: (v: string | null) => void }) {
  const catalogs = useCatalogs();
  const { unitPathNames } = useLookups();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const options = (catalogs.data ?? []).filter((c) => unitPath.includes(c.unitId) && (c.permissions.includes('edit') || c.id === value));
  if (!options.length && !value) return <p className="text-xs text-muted">{t('No catalogs for this team yet.')}</p>;
  const selected = (catalogs.data ?? []).find((c) => c.id === value);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = options.filter((c) => {
    const text = `${c.name} ${c.description ?? ''} ${unitPathNames(c.unitId).join(' ')}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const select = (v: string | null) => {
    onChange(v);
    setOpen(false);
    setQ('');
  };
  const item = 'flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] data-[selected=true]:bg-surface-2';
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[var(--radix-popover-trigger-width)] min-w-72"
      phoneTitle={t('Choose a catalog')}
      trigger={
        <button id={id} type="button" className={triggerClass}>
          {selected ? (
            <>
              <TypeIcon icon={selected.icon} color={selected.color} size={18} />
              <span className="truncate">{selected.name}</span>
            </>
          ) : (
            <span className="text-subtle">{t('Not in a catalog')}</span>
          )}
          <ChevronsUpDown className="ms-auto size-3.5 shrink-0 text-subtle" />
        </button>
      }
    >
      <Command shouldFilter={false} className="flex flex-col">
        <Command.Input value={q} onValueChange={setQ} placeholder={t('Search catalogs…')} className="h-9 border-b border-border bg-transparent px-3 text-[13px] outline-none placeholder:text-subtle" />
        <Command.List className="max-h-72 overflow-y-auto p-1">
          <Command.Empty className="px-3 py-6 text-center text-xs text-muted">{t('No matching catalogs')}</Command.Empty>
          {!words.length && (
            <Command.Item value="__none" onSelect={() => select(null)} className={item}>
              <span className="text-muted">{t('Not in a catalog')}</span>
              {!value && <Check className="ms-auto size-3.5 text-accent-fg" />}
            </Command.Item>
          )}
          {shown.map((c) => (
            <Command.Item key={c.id} value={c.id} onSelect={() => select(c.id)} className={item}>
              <TypeIcon icon={c.icon} color={c.color} size={20} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{c.name}</span>
                <span className="block truncate text-xs text-muted">
                  {unitPathNames(c.unitId).join(' › ')}
                  {c.shares.length ? ` · ${t('shared with {count}', { count: c.shares.length })}` : ''}
                </span>
              </span>
              {c.id === value && <Check className="size-3.5 shrink-0 text-accent-fg" />}
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </Popover>
  );
}
