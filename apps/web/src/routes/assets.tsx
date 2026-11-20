import type { SavedView } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Bookmark, FileUp, MoreHorizontal, Pencil, Pin, PinOff, Plus, Shapes, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AssetExplorer } from '@/components/asset-explorer';
import { AssetFormSheet } from '@/components/asset-form';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { EmptyState, IconTile, PageHeader, Spinner } from '@/components/ui/display';
import { Input } from '@/components/ui/form';
import { Dialog, Menu, MenuItem } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { useMyOrg } from '@/lib/org';
import { keys, useLookups, useViews } from '@/lib/queries';
import { useShortcut } from '@/lib/shortcuts';
import { t } from '@/lib/i18n';
import { inSentence } from '@/lib/utils';

/** Create button for a type, shown only where the person can add assets. */
export function useCanCreate(assetTypeId: string | undefined) {
  const { me, can } = useMyOrg();
  const { units, typeById } = useLookups();
  const type = assetTypeId ? typeById.get(assetTypeId) : undefined;
  return !!type && !type.archived && (!!me?.isAdmin || units.some((u) => can(u.id, 'create', type.id)));
}

export function AssetsPage() {
  const { type: typeId, q, import: importId, new: startNew } = useSearch({ strict: false }) as { type?: string; q?: string; import?: string; new?: string };
  const lookups = useLookups();
  const type = typeId ? lookups.typeById.get(typeId) : undefined;
  const [creating, setCreating] = useState(false);
  const canCreate = useCanCreate(typeId);
  const navigate = useNavigate();
  useShortcut('n', canCreate ? () => setCreating(true) : null);
  // "?new=1" (the palette's "New laptop", the N shortcut) opens the form once, then leaves the address clean.
  useEffect(() => {
    if (startNew && canCreate) {
      setCreating(true);
      void navigate({ to: '/assets', search: { type: typeId, q, import: importId }, replace: true });
    }
  }, [startNew, canCreate]);

  return (
    <>
      <PageHeader
        title={type?.name ?? t('All assets')}
        description={type?.description ?? t('Everything you can see, across every type and team.')}
        icon={type ? <TypeIcon icon={type.icon} color={type.color} size={36} /> : undefined}
        actions={
          <>
            <Link to="/import" search={{ type: typeId }}>
              <Button icon={<FileUp className="size-4" />}>{t('Import')}</Button>
            </Link>
            {canCreate && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                {t('New {type}', { type: inSentence(type!.name) })}
              </Button>
            )}
          </>
        }
      >
        {importId && (
          <p className="mt-2 flex items-center gap-2 text-xs text-muted">
            {t('Showing the items one import added.')}
            <Link to="/assets" search={{ type: typeId }} className="text-accent-fg hover:underline">
              {t('Show everything')}
            </Link>
          </p>
        )}
      </PageHeader>
      <AssetExplorer
        fixed={{ ...(typeId && { assetTypeId: typeId }), ...(importId && { importBatchId: importId }) }}
        initial={q ? { q } : undefined}
        empty={
          <EmptyState
            icon={<Shapes />}
            title={t('No assets yet')}
            description={type ? t('Create the first {type} to start tracking it.', { type: inSentence(type.name) }) : t('Pick an asset type in the sidebar to add one.')}
            action={canCreate ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('New {type}', { type: inSentence(type!.name) })}</Button> : undefined}
          />
        }
      />
      {type && <AssetFormSheet open={creating} onOpenChange={setCreating} type={type} />}
    </>
  );
}

export function SavedViewPage() {
  const { viewId } = useParams({ strict: false }) as { viewId: string };
  const views = useViews();
  const view = views.data?.find((v) => v.id === viewId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const save = useMutation({
    mutationFn: (v: SavedView) => api.put(`/api/registry/views/${v.id}`, { name: v.name, query: v.query, pinned: v.pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.views }),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/registry/views/${viewId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.views });
      toast.success(t('View deleted'));
      void navigate({ to: '/assets' });
    },
  });

  if (views.isLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!view) return <EmptyState title={t('View not found')} description={t('It may have been deleted.')} />;

  return (
    <>
      <PageHeader
        title={view.name}
        description={t('Saved view')}
        icon={
          <IconTile color="#6366f1" size={36}>
            <Bookmark />
          </IconTile>
        }
        actions={
          <Menu trigger={<Button size="icon" aria-label={t('View options')} icon={<MoreHorizontal className="size-4" />} />}>
            <MenuItem icon={view.pinned ? <PinOff /> : <Pin />} onSelect={() => save.mutate({ ...view, pinned: !view.pinned })}>
              {view.pinned ? t('Unpin from sidebar') : t('Pin to sidebar')}
            </MenuItem>
            <MenuItem icon={<Pencil />} onSelect={() => (setName(view.name), setRenaming(true))}>
              {t('Rename…')}
            </MenuItem>
            <MenuItem danger icon={<Trash2 />} onSelect={() => remove.mutate()}>
              {t('Delete view')}
            </MenuItem>
          </Menu>
        }
      />
      <AssetExplorer initial={view.query} view={view} />
      <Dialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t('Rename view')}
        footer={
          <>
            <Button onClick={() => setRenaming(false)}>{t('Cancel')}</Button>
            <Button variant="primary" disabled={!name.trim()} onClick={() => (save.mutate({ ...view, name: name.trim() }), setRenaming(false))}>
              {t('Save')}
            </Button>
          </>
        }
      >
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Dialog>
    </>
  );
}
