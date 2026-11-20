import { type AssetType } from '@am/core';
import { accessLabel } from '@/components/access';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMediaQuery } from '@/lib/hooks';
import { FileUp, FolderOpen, MoreHorizontal, Pencil, Plus, Share2, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AssetExplorer } from '@/components/asset-explorer';
import { AssetFormSheet } from '@/components/asset-form';
import { CatalogCard, CatalogFormDialog, ShareDialog, useManageableUnits } from '@/components/catalogs';
import { UnitPath } from '@/components/pickers';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, Skeleton, Spinner } from '@/components/ui/display';
import { ConfirmDialog, Menu, MenuItem } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { plural, t } from '@/lib/i18n';
import { tj } from '@/lib/i18n-react';
import { keys, useCatalog, useCatalogs, useLookups } from '@/lib/queries';
import { useShortcut } from '@/lib/shortcuts';
import { useRemember } from '@/lib/recent';

export function CatalogsPage() {
  const catalogs = useCatalogs();
  const manageable = useManageableUnits();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  useShortcut('n', manageable.length > 0 ? () => setCreating(true) : null);
  const shared = (catalogs.data ?? []).filter((c) => c.sharedWithMe);
  const own = (catalogs.data ?? []).filter((c) => !c.sharedWithMe);

  return (
    <>
      <PageHeader
        title={t('Catalogs')}
        description={t('Collections that units keep and share: a division’s licenses, a lab’s equipment, a team’s tools. Sharing a catalog gives another team or person access to everything in it.')}
        actions={
          manageable.length > 0 && (
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
              {t('New catalog')}
            </Button>
          )
        }
      />
      <div className="mx-auto w-full max-w-6xl space-y-8 px-4 sm:px-6 py-6">
        {catalogs.isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : !catalogs.data?.length ? (
          <Card>
            <EmptyState
              icon={<FolderOpen />}
              title={t('No catalogs yet')}
              description={manageable.length ? t('Create one for your unit, add assets to it, and share it with the teams that use them.') : t('When another unit shares a catalog with you or your team, it shows up here.')}
              action={manageable.length > 0 && <Button onClick={() => setCreating(true)}>{t('New catalog')}</Button>}
            />
          </Card>
        ) : (
          <>
            {shared.length > 0 && <Section title={t('Shared with you')} hint={t('From other units, to you or one of your teams')} items={shared} />}
            {own.length > 0 && <Section title={t('Your organization’s')} hint={t('Owned by units you belong to or oversee')} items={own} />}
          </>
        )}
      </div>
      <CatalogFormDialog open={creating} onOpenChange={setCreating} onSaved={(c) => void navigate({ to: '/catalogs/$catalogId', params: { catalogId: c.id } })} />
    </>
  );
}

function Section({ title, hint, items }: { title: string; hint: string; items: NonNullable<ReturnType<typeof useCatalogs>['data']> }) {
  return (
    <section>
      <h2 className="text-[13px] font-semibold">{title}</h2>
      <p className="mb-3 text-xs text-muted">{hint}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => (
          <CatalogCard key={c.id} catalog={c} />
        ))}
      </div>
    </section>
  );
}

export function CatalogPage() {
  const { catalogId } = useParams({ strict: false }) as { catalogId: string };
  const catalog = useCatalog(catalogId);
  const { types } = useLookups();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const phone = useMediaQuery('(max-width: 639px)');
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState<AssetType | null>(null);
  useRemember(catalog.data ? { kind: 'catalog', id: catalog.data.id, title: catalog.data.name, subtitle: t('Catalog') } : null);

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/registry/catalogs/${catalogId}`),
    onSuccess: () => {
      toast.success(t('Catalog deleted'), { description: t('Its assets stay with their teams.') });
      void qc.invalidateQueries({ queryKey: keys.catalogs });
      void qc.invalidateQueries({ queryKey: keys.assets });
      void navigate({ to: '/catalogs' });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Delete failed')),
  });

  if (catalog.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!catalog.data) return <EmptyState title={t('Catalog not found')} description={t('It may have been deleted, or it is not shared with you.')} action={<Link to="/catalogs" className="text-accent-fg">{t('All catalogs')}</Link>} />;

  const c = catalog.data;
  const canAdd = c.permissions.includes('create');
  const canManage = c.permissions.includes('manage');
  const sharedUnits = c.shares.filter((s) => s.subject.kind !== 'user');
  const sharedPeople = c.shares.length - sharedUnits.length;

  return (
    <>
      <PageHeader
        icon={<TypeIcon icon={c.icon} color={c.color} size={40} />}
        title={c.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link to="/units/$unitId" params={{ unitId: c.unitId }} className="hover:text-fg">
              <UnitPath id={c.unitId} />
            </Link>
            {c.sharedWithMe && <Badge tone="accent">{t('Shared with you · {access}', { access: accessLabel(c.permissions) })}</Badge>}
            {c.description && <span className="text-muted">· {c.description}</span>}
          </span>
        }
        actions={
          <>
            <Button icon={canManage ? <Share2 className="size-3.5" /> : <Users className="size-3.5" />} onClick={() => setSharing(true)}>
              {canManage ? t('Share') : t('Who has access')}
              {c.shares.length > 0 && <span className="ms-1 text-muted">{c.shares.length}</span>}
            </Button>
            {canAdd && !phone && (
              <Link to="/import" search={{ unit: c.unitId, catalog: c.id }}>
                <Button icon={<FileUp className="size-3.5" />}>{t('Import')}</Button>
              </Link>
            )}
            {canAdd && (
              <Menu trigger={<Button variant="primary" icon={<Plus className="size-3.5" />}>{t('Add item')}</Button>}>
                {types
                  .filter((ty) => !ty.archived)
                  .map((ty) => (
                    <MenuItem key={ty.id} icon={<TypeIcon icon={ty.icon} color={ty.color} size={18} />} onSelect={() => setAdding(ty)}>
                      {ty.name}
                    </MenuItem>
                  ))}
              </Menu>
            )}
            {(canManage || (canAdd && phone)) && (
              <Menu trigger={<Button size="icon" aria-label={t('More')} icon={<MoreHorizontal className="size-4" />} />}>
                {canAdd && phone && (
                  <MenuItem icon={<FileUp />} onSelect={() => void navigate({ to: '/import', search: { unit: c.unitId, catalog: c.id } })}>
                    {t('Import a spreadsheet')}
                  </MenuItem>
                )}
                {canManage && (
                  <>
                    <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
                      {t('Edit catalog')}
                    </MenuItem>
                    <MenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(true)}>
                      {t('Delete catalog')}
                    </MenuItem>
                  </>
                )}
              </Menu>
            )}
          </>
        }
      >
        {c.shares.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Share2 className="size-3" />
            {tj('Shared with {units}{more}{people}', {
              units: sharedUnits.slice(0, 4).map((s) => <Badge key={s.subject.id}>{s.subject.name}</Badge>),
              more: sharedUnits.length > 4 && <span>{plural(sharedUnits.length - 4, '+{n} unit', '+{n} units')}</span>,
              people:
                sharedPeople > 0 && (
                  <span>{sharedUnits.length ? plural(sharedPeople, 'and {n} person', 'and {n} people') : plural(sharedPeople, '{n} person', '{n} people')}</span>
                ),
            })}
          </p>
        )}
      </PageHeader>
      <AssetExplorer
        fixed={{ catalogId: c.id }}
        title={c.name}
        empty={<EmptyState icon={<FolderOpen />} title={t('Nothing in this catalog yet')} description={canAdd ? t('Add new items here, or open an existing asset and choose this catalog when editing it.') : t('Items appear here when its owners add them.')} />}
      />
      <ShareDialog catalog={c} open={sharing} onOpenChange={setSharing} />
      <CatalogFormDialog open={editing} onOpenChange={setEditing} catalog={c} />
      {adding && <AssetFormSheet open onOpenChange={(o) => !o && setAdding(null)} type={adding} catalog={c} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        danger
        title={t('Delete {name}?', { name: c.name })}
        description={t('The catalog and its sharing are removed. Its assets are not deleted: they stay with their teams, visible as before to the organization chart only.')}
        confirmLabel={t('Delete catalog')}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
