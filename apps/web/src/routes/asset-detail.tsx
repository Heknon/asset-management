import { canSeeField, isRestricted, type ActivityEntry, type AssetType, type FieldDefinition } from '@am/core';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { CalendarClock, Plus, Users, FolderOpen, History, MoreHorizontal, Pencil, Sparkles, Trash2, Workflow } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AssetFormSheet } from '@/components/asset-form';
import { AttributeInput, AttributeValue } from '@/components/attribute';
import { AccessBadge, StatusBadge } from '@/components/badges';
import { Conversation } from '@/components/conversation';
import { Documents } from '@/components/documents';
import { ObligationList } from '@/components/obligations';
import { PersonName, PersonPicker, UnitPath } from '@/components/pickers';
import { RequestStatusBadge } from '@/components/badges';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader, SectionTitle, Spinner } from '@/components/ui/display';
import { ConfirmDialog, Menu, MenuItem } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useActivity, useAsset, useAssetRequest, useCatalog, useInvalidateAssets, useLookups, useMe, useObligations } from '@/lib/queries';
import { plural, t, tMaybe } from '@/lib/i18n';
import { tj } from '@/lib/i18n-react';
import { formatDate, formatDateTime, inSentence } from '@/lib/utils';
import type { Asset, Obligation, Permission, WorkflowView } from '@am/core';
import { useRemember } from '@/lib/recent';

export function AssetDetailPage() {
  const { assetId } = useParams({ strict: false }) as { assetId: string };
  const asset = useAsset(assetId);
  const me = useMe().data!;
  const lookups = useLookups();
  const navigate = useNavigate();
  const invalidate = useInvalidateAssets();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const type = asset.data ? lookups.typeById.get(asset.data.assetTypeId) : undefined;
  // The template plus the fields a team added to this item.
  const schema = asset.data ? lookups.schemaOf(asset.data.assetTypeId, asset.data.variantId) : undefined;
  useRemember(asset.data && type ? { kind: 'asset', id: asset.data.id, title: asset.data.name, subtitle: asset.data.reference, icon: type.icon, color: type.color } : null);

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/registry/assets/${assetId}`),
    onSuccess: () => {
      toast.success(t('Asset deleted'));
      invalidate();
      void navigate({ to: '/assets', search: { type: asset.data?.assetTypeId } });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Delete failed')),
  });

  if (asset.isLoading || !lookups.ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!asset.data || !type || !schema) return <EmptyState title={t('Asset not found')} description={t('It may have been deleted, or you may not have access.')} action={<Link to="/assets" className="text-accent-fg">{t('Back to assets')}</Link>} />;

  const a = asset.data;
  const can = (perm: Permission) => a.permissions.includes(perm);
  const canEdit = can('edit');

  return (
    <>
      <PageHeader
        icon={<TypeIcon icon={type.icon} color={type.color} size={40} />}
        title={a.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-subtle" title={t('Item ID')}>
              {a.reference}
            </span>
            <Link to="/assets" search={{ type: type.id }} className="hover:text-fg" title={t('All {type} items', { type: inSentence(type.name) })}>
              {type.name}
            </Link>
            <StatusBadge type={type} status={a.status} />
            <Link to="/units/$unitId" params={{ unitId: a.unitId }} className="hover:text-fg">
              <UnitPath id={a.unitId} />
            </Link>
            <CatalogLink catalogId={a.catalogId} />
            <AccessBadge permissions={a.permissions} />
          </span>
        }
        actions={
          canEdit && (
            <>
              <Button icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
                {t('Edit')}
              </Button>
              {can('delete') && (
                <Menu trigger={<Button size="icon" aria-label={t('More')} icon={<MoreHorizontal className="size-4" />} />}>
                  <MenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(true)}>
                    {t('Delete asset')}
                  </MenuItem>
                </Menu>
              )}
            </>
          )
        }
      />
      <div className="mx-auto grid grid-cols-1 w-full max-w-6xl gap-6 px-4 sm:px-6 py-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Details assetId={a.id} type={type} attributes={a.attributes} ownerId={a.ownerId} canSeeRestricted={can('restricted')} canEdit={canEdit} />
          <TeamFields asset={a} type={type} canSeeRestricted={can('restricted')} />
          <Documents assetId={a.id} canEdit={can('attach')} canManage={can('delete')} currentUserId={me.userId} />
          <Conversation assetId={a.id} permissions={a.permissions} />
        </div>
        <div className="space-y-6">
          <OriginRequest assetId={a.id} />
          {a.workflows.length > 0 && <ItemWorkflows assetId={a.id} workflows={a.workflows} />}
          <KeyDates assetId={a.id} canEdit={can('renew')} />
          <Activity assetId={a.id} type={schema} />
        </div>
      </div>
      <AssetFormSheet open={editing} onOpenChange={setEditing} type={type} asset={a} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        danger
        title={t('Delete {name}?', { name: a.name })}
        description={t('The asset, its documents and its reminders are removed permanently. Activity history is kept.')}
        confirmLabel={t('Delete')}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

function Details({ assetId, type, attributes, ownerId, canSeeRestricted, canEdit }: { assetId: string; type: AssetType; attributes: Record<string, unknown>; ownerId: string | null; canSeeRestricted: boolean; canEdit: boolean }) {
  const invalidate = useInvalidateAssets();
  const meId = useMe().data?.userId;
  const save = useMutation({
    mutationFn: (patch: { attributes?: Record<string, unknown>; ownerId?: string | null }) => api.patch(`/api/registry/assets/${assetId}`, patch),
    onSuccess: () => invalidate(assetId),
  });
  const saveValue = (patch: { attributes?: Record<string, unknown>; ownerId?: string | null }) =>
    save.mutateAsync(patch).catch((e) => {
      toast.error(e instanceof ApiError ? e.message : t('Could not save'));
      throw e;
    });
  const sections = useMemo(() => {
    const out: Array<[string, FieldDefinition[]]> = [];
    for (const f of type.fields) {
      if (!canSeeField(f, { canSeeRestricted, isOwner: !!ownerId && ownerId === meId })) continue;
      const key = f.section ?? '';
      const group = out.find(([k]) => k === key);
      if (group) group[1].push(f);
      else out.push([key, [f]]);
    }
    return out;
  }, [type, canSeeRestricted, ownerId, meId]);

  return (
    <Card padded={false}>
      <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-6 gap-y-3 border-b border-border px-5 py-4 text-[13px]">
        <span className="text-muted">{t('Owner')}</span>
        {canEdit ? (
          <InlineEdit
            label={t('Owner')}
            display={<PersonName id={ownerId} fallback={t('Unassigned')} />}
            editor={(close) => (
              <PersonPicker
                value={ownerId}
                placeholder={t('Unassigned')}
                onChange={(id) => void saveValue({ ownerId: id }).then(close, () => undefined)}
              />
            )}
          />
        ) : (
          <PersonName id={ownerId} fallback={t('Unassigned')} />
        )}
      </div>
      {sections.map(([section, fields]) => (
        <div key={section} className="border-b border-border px-5 py-4 last:border-0">
          <h3 className="mb-3 text-xs font-semibold tracking-wide text-subtle uppercase">{section || t('Details')}</h3>
          <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-6 gap-y-3 text-[13px]">
            {fields.map((f) => (
              <div key={f.key} className="contents">
                <dt className="flex items-center gap-1 text-muted">
                  {f.label}
                  {f.kind === 'date' && f.config.tracking?.derive && <Sparkles className="size-3 text-accent" aria-label={t('Calculated')} />}
                </dt>
                <dd className="min-w-0">
                  {canEdit && (!isRestricted(f) || canSeeRestricted) && !(f.kind === 'date' && f.config.tracking?.derive) ? (
                    <InlineEdit
                      label={f.label}
                      display={<AttributeValue field={f} value={attributes[f.key] as never} />}
                      initial={attributes[f.key]}
                      editor={(close, value, setValue) => (
                        <AttributeInput id={`inline-${f.key}`} field={f} value={value} onChange={setValue} />
                      )}
                      onSave={(v) => saveValue({ attributes: { [f.key]: v } })}
                    />
                  ) : (
                    <AttributeValue field={f} value={attributes[f.key] as never} />
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </Card>
  );
}

/**
 * A team's own fields on this item ("for us, this is an AVI license"). Only
 * items a team marked have them; the team turns them on, fills them in and
 * removes them, without edit rights on the item. Nobody else has to fill them.
 */
function TeamFields({ asset, type, canSeeRestricted }: { asset: Asset; type: AssetType; canSeeRestricted: boolean }) {
  const { variantById, unitById } = useLookups();
  const invalidate = useInvalidateAssets();
  const meId = useMe().data?.userId;
  const [removing, setRemoving] = useState(false);
  const access = asset.teamFields ?? { choices: [], canFill: false };
  const variant = asset.variantId ? variantById.get(asset.variantId) : undefined;
  const save = useMutation({
    mutationFn: (body: { variantId?: string | null; attributes?: Record<string, unknown> }) => api.put<Asset>(`/api/registry/assets/${asset.id}/team-fields`, { attributes: {}, ...body }),
    onSuccess: () => invalidate(asset.id),
  });
  const saveValue = (attributes: Record<string, unknown>) =>
    save.mutateAsync({ attributes }).catch((e) => {
      toast.error(e instanceof ApiError ? e.message : t('Could not save'));
      throw e;
    });
  const turnOn = (variantId: string) =>
    save.mutate({ variantId }, { onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Could not save')) });
  const others = access.choices.filter((c) => c.id !== asset.variantId);
  const teamName = (unitId: string) => unitById.get(unitId)?.name ?? '';

  if (!variant) {
    if (!others.length) return null;
    const add = (c: (typeof others)[number]) => t('Add {team}’s fields ({name})', { team: teamName(c.unitId), name: c.name });
    return (
      <Card className="flex flex-wrap items-center gap-3">
        <Users className="size-4 shrink-0 text-muted" />
        <p className="min-w-0 flex-1 text-[13px] text-muted">{t('Does your team keep more details about this {type}? Add your fields to this item only.', { type: inSentence(type.name) })}</p>
        {others.length === 1 ? (
          <Button size="sm" icon={<Plus className="size-3.5" />} loading={save.isPending} onClick={() => turnOn(others[0]!.id)}>
            {add(others[0]!)}
          </Button>
        ) : (
          <Menu trigger={<Button size="sm" icon={<Plus className="size-3.5" />} loading={save.isPending}>{t('Add team fields')}</Button>}>
            {others.map((c) => (
              <MenuItem key={c.id} onSelect={() => turnOn(c.id)}>
                {add(c)}
              </MenuItem>
            ))}
          </Menu>
        )}
      </Card>
    );
  }

  const fields = variant.fields.filter((f) => canSeeField(f, { canSeeRestricted, isOwner: !!asset.ownerId && asset.ownerId === meId }));
  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Users className="size-4 text-muted" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold">{t('{team}’s fields', { team: teamName(variant.unitId) })}</h3>
          <p className="truncate text-xs text-subtle">{t('For them, this is: {name}', { name: variant.name })}</p>
        </div>
        {access.canFill && (
          <Menu trigger={<Button size="icon" aria-label={t('More')} icon={<MoreHorizontal className="size-4" />} />}>
            {others.map((c) => (
              <MenuItem key={c.id} onSelect={() => turnOn(c.id)}>
                {t('Switch to {team}’s fields ({name})', { team: teamName(c.unitId), name: c.name })}
              </MenuItem>
            ))}
            <MenuItem danger icon={<Trash2 />} onSelect={() => setRemoving(true)}>
              {t('Remove these fields')}
            </MenuItem>
          </Menu>
        )}
      </div>
      {fields.length ? (
        <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-6 gap-y-3 px-5 py-4 text-[13px]">
          {fields.map((f) => {
            const empty = asset.attributes[f.key] === undefined || asset.attributes[f.key] === null || asset.attributes[f.key] === '';
            const display = empty && f.required ? <span className="text-warning">{t('To fill in')}</span> : <AttributeValue field={f} value={asset.attributes[f.key] as never} />;
            return (
              <div key={f.key} className="contents">
                <dt className="text-muted">{f.label}</dt>
                <dd className="min-w-0">
                  {access.canFill && (!isRestricted(f) || canSeeRestricted) && !(f.kind === 'date' && f.config.tracking?.derive) ? (
                    <InlineEdit
                      label={f.label}
                      display={display}
                      initial={asset.attributes[f.key]}
                      editor={(_close, value, setValue) => <AttributeInput id={`team-${f.key}`} field={f} value={value} onChange={setValue} />}
                      onSave={(v) => saveValue({ [f.key]: v })}
                    />
                  ) : (
                    display
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="px-5 py-4 text-xs text-muted">{t('No fields of their own yet; their workflows apply.')}</p>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        danger
        title={t('Remove {team}’s fields from {name}?', { team: teamName(variant.unitId), name: asset.name })}
        description={t('What was filled in them is removed from this item (the history keeps it).')}
        confirmLabel={t('Remove')}
        loading={save.isPending}
        onConfirm={() => save.mutate({ variantId: null }, { onSuccess: () => setRemoving(false), onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Could not save')) })}
      />
    </Card>
  );
}

/** "In R&D Labs" (with who it is shared with) when the asset is filed in a catalog. */
function CatalogLink({ catalogId }: { catalogId: string | null }) {
  const catalog = useCatalog(catalogId);
  if (!catalogId || !catalog.data) return null;
  const c = catalog.data;
  return (
    <Link to="/catalogs/$catalogId" params={{ catalogId: c.id }} className="inline-flex items-center gap-1 hover:text-fg" title={c.shares.length ? plural(c.shares.length, 'Shared with {n} unit or person', 'Shared with {n} units or people') : undefined}>
      <FolderOpen className="size-3" />
      {c.name}
      {c.shares.length > 0 && <span className="text-subtle">· {t('shared')}</span>}
    </Link>
  );
}

function KeyDates({ assetId, canEdit }: { assetId: string; canEdit: boolean }) {
  const active = useObligations({ assetId, state: 'active', limit: 50 });
  const history = useObligations({ assetId, state: 'done', limit: 10 });
  // Opened from a "Do you still need it?" email: show the answer dialog.
  const { check } = useSearch({ strict: false }) as { check?: string };
  const navigate = useNavigate();
  const [answering, setAnswering] = useState<Obligation | null>(null);
  useEffect(() => {
    const o = check && active.data?.items.find((x) => x.id === check);
    if (o && o.check?.status === 'asked') setAnswering(o);
  }, [check, active.data]);
  const closeAnswer = (o: Obligation | null) => {
    setAnswering(o);
    if (!o && check) void navigate({ to: '.', search: {}, replace: true });
  };
  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <CalendarClock className="size-4 text-muted" />
        <h2 className="text-[13px] font-semibold">{t('Key dates')}</h2>
      </div>
      {active.data?.items.length ? (
        <ObligationList items={active.data.items} showAsset={false} canEdit={() => canEdit} answering={answering} onAnsweringChange={closeAnswer} />
      ) : (
        <p className="px-4 py-6 text-center text-xs text-muted">{active.isLoading ? t('Loading…') : t('No upcoming tracked dates.')}</p>
      )}
      {!!history.data?.items.length && (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-xs font-medium text-subtle">{t('Completed')}</p>
          <ul className="space-y-1.5 text-xs text-muted">
            {history.data.items.map((o) => (
              <li key={o.id} className="flex justify-between gap-2">
                <span className="truncate">
                  {o.label} · {formatDate(o.dueDate)}
                </span>
                <span>{o.resolvedAt ? formatDateTime(o.resolvedAt) : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** Where this asset came from, when it was bought through a request. */
function OriginRequest({ assetId }: { assetId: string }) {
  const r = useAssetRequest(assetId);
  if (!r.data) return null;
  return (
    <Link to="/requests/$requestId" params={{ requestId: r.data.id }} className="block">
      <Card className="flex items-center gap-3 transition-colors hover:border-border-strong">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">{t('Bought for request {number}', { number: r.data.number })}</p>
          <p className="truncate text-[13px] font-medium">{r.data.title}</p>
          <p className="text-xs text-subtle">{t('Requested by {name}', { name: r.data.requesterName })}</p>
        </div>
        <RequestStatusBadge status={r.data.statusInfo} />
      </Card>
    </Link>
  );
}

/** Whole sentences, so the actor can sit wherever the language puts them. */
const actionSentences: Record<ActivityEntry['action'], string> = { created: '{actor} created this asset', updated: '{actor} updated', deleted: '{actor} deleted', advanced: '{actor} rolled a date forward' };

/**
 * The item's own workflows ("Machine status"), from its template and team
 * variant. Everyone sees them; the unit responsible for each moves it.
 */
function ItemWorkflows({ assetId, workflows }: { assetId: string; workflows: WorkflowView[] }) {
  const invalidate = useInvalidateAssets();
  const move = useMutation({
    mutationFn: ({ key, status }: { key: string; status: string }) => api.post<Asset>(`/api/registry/assets/${assetId}/workflows/${key}`, { status }),
    onSuccess: (a, { key }) => {
      const w = a.workflows.find((x) => x.key === key);
      if (w?.statusInfo) toast.success(t('{workflow}: moved to “{status}”', { workflow: tMaybe(w.name), status: tMaybe(w.statusInfo.label) }));
      invalidate(assetId);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Something went wrong')),
  });
  return (
    <Card className="space-y-3">
      <SectionTitle aside={<Workflow className="size-4 text-subtle" />}>{t('Workflows')}</SectionTitle>
      <ul className="space-y-3">
        {workflows.map((w) => (
          <li key={w.key} className="space-y-2 text-[13px]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{tMaybe(w.name)}</span>
                <span className="block text-xs text-muted">{tj('Responsible: {unit}', { unit: <UnitPath id={w.responsibleUnitId} leafOnly /> })}</span>
              </span>
              {w.statusInfo && <RequestStatusBadge status={w.statusInfo} />}
            </div>
            {w.moves.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {w.moves.map((m) => (
                  <Button key={m.key} size="xs" variant={m.category === 'done' ? 'primary' : 'secondary'} disabled={move.isPending} onClick={() => move.mutate({ key: w.key, status: m.key })}>
                    {tMaybe(m.label)}
                  </Button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Activity({ assetId, type }: { assetId: string; type: AssetType }) {
  const activity = useActivity(assetId);
  const label = (key: string) => {
    if (key.startsWith('workflow:')) return tMaybe(key.slice(9));
    if (key === 'note') return t('Note');
    if (key.startsWith('attributes.')) return type.fields.find((f) => f.key === key.slice(11))?.label ?? key.slice(11);
    return { name: t('Name'), status: t('Status'), ownerId: t('Owner'), unitId: t('Team'), catalogId: t('Catalog'), variantId: t('Team fields'), reminderOverrides: t('Reminders'), request: t('Request') }[key] ?? key;
  };
  return (
    <Card>
      <SectionTitle aside={<History className="size-4 text-subtle" />}>{t('Activity')}</SectionTitle>
      <ol className="relative space-y-4 border-s border-border ps-4">
        {(activity.data ?? []).map((e) => (
          <li key={e.id} className="text-[13px]">
            <span className="absolute -start-[4.5px] mt-1.5 size-2 rounded-full border-2 border-surface bg-border-strong" />
            <p>
              <span className="text-muted">{tj(actionSentences[e.action], { actor: <span className="font-medium text-fg">{e.actorName}</span> })}</span>
            </p>
            {e.action !== 'created' && (
              <p className="mt-0.5 text-xs text-subtle">
                {Object.keys(e.changes)
                  .map(label)
                  .join(t(', '))}
              </p>
            )}
            <p className="mt-0.5 text-xs text-subtle">{formatDateTime(e.at)}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * A value you can change where you read it: click it (or tab to it and press
 * Enter), change it, Enter or Save keeps it, Esc puts it back. Fields that pick
 * from a list save as soon as you choose (no `onSave`).
 */
function InlineEdit({
  label,
  display,
  initial,
  editor,
  onSave,
}: {
  label: string;
  display: React.ReactNode;
  initial?: unknown;
  editor: (close: () => void, value: unknown, setValue: (v: unknown) => void) => React.ReactNode;
  onSave?: (value: unknown) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<unknown>(initial);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing) box.current?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea,button')?.focus();
  }, [editing]);
  const close = () => setEditing(false);
  const commit = async () => {
    if (!onSave) return close();
    if (JSON.stringify(value ?? null) === JSON.stringify(initial ?? null)) return close();
    setSaving(true);
    try {
      await onSave(value === '' ? null : value);
      close();
    } catch {
      /* the error is shown; keep editing */
    } finally {
      setSaving(false);
    }
  };
  if (!editing)
    return (
      <button
        type="button"
        onClick={() => (setValue(initial), setEditing(true))}
        className="group/edit -mx-1.5 -my-1 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-start transition-colors hover:bg-surface-2"
        title={t('Edit {label}', { label })}
        aria-label={t('Edit {label}', { label })}
      >
        <span className="min-w-0 flex-1">{display}</span>
        <Pencil className="size-3 shrink-0 text-subtle opacity-0 transition-opacity group-hover/edit:opacity-100 group-focus-visible/edit:opacity-100 touch:opacity-60" />
      </button>
    );
  return (
    <div
      ref={box}
      className="space-y-1.5"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
        if (e.key === 'Enter' && onSave && !(e.target instanceof HTMLTextAreaElement && !(e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          void commit();
        }
      }}
    >
      {editor(close, value, setValue)}
      {onSave && (
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="primary" loading={saving} onClick={() => void commit()}>
            {t('Save')}
          </Button>
          <Button size="xs" variant="ghost" onClick={close}>
            {t('Cancel')}
          </Button>
          <span className="text-[11px] text-subtle max-sm:hidden">{t('Enter to save · Esc to cancel')}</span>
        </div>
      )}
    </div>
  );
}
