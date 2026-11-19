import { atLeast, type AssetType } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { FolderOpen, MoreHorizontal, Pencil, Plus, Share2, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AssetExplorer } from '@/components/asset-explorer';
import { AssetFormSheet } from '@/components/asset-form';
import { CatalogCard, CatalogFormDialog, levelLabel, ShareDialog, useManageableUnits } from '@/components/catalogs';
import { UnitPath } from '@/components/pickers';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, Skeleton, Spinner } from '@/components/ui/display';
import { ConfirmDialog, Menu, MenuItem } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { keys, useCatalog, useCatalogs, useLookups } from '@/lib/queries';

export function CatalogsPage() {
  const catalogs = useCatalogs();
  const manageable = useManageableUnits();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const shared = (catalogs.data ?? []).filter((c) => c.sharedWithMe);
  const own = (catalogs.data ?? []).filter((c) => !c.sharedWithMe);

  return (
    <>
      <PageHeader
        title="Catalogs"
        description="Collections that units keep and share: a division’s licenses, a lab’s equipment, a team’s tools. Sharing a catalog gives another team or person access to everything in it."
        actions={
          manageable.length > 0 && (
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
              New catalog
            </Button>
          )
        }
      />
      <div className="mx-auto w-full max-w-6xl space-y-8 px-6 py-6">
        {catalogs.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : !catalogs.data?.length ? (
          <Card>
            <EmptyState
              icon={<FolderOpen />}
              title="No catalogs yet"
              description={manageable.length ? 'Create one for your unit, add assets to it, and share it with the teams that use them.' : 'When another unit shares a catalog with you or your team, it shows up here.'}
              action={manageable.length > 0 && <Button onClick={() => setCreating(true)}>New catalog</Button>}
            />
          </Card>
        ) : (
          <>
            {shared.length > 0 && <Section title="Shared with you" hint="From other units, to you or one of your teams" items={shared} />}
            {own.length > 0 && <Section title="Your organization’s" hint="Owned by units you belong to or oversee" items={own} />}
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
  const { types, unitById } = useLookups();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState<AssetType | null>(null);

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/registry/catalogs/${catalogId}`),
    onSuccess: () => {
      toast.success('Catalog deleted', { description: 'Its assets stay with their teams.' });
      void qc.invalidateQueries({ queryKey: keys.catalogs });
      void qc.invalidateQueries({ queryKey: keys.assets });
      void navigate({ to: '/catalogs' });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Delete failed'),
  });

  if (catalog.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!catalog.data) return <EmptyState title="Catalog not found" description="It may have been deleted, or it is not shared with you." action={<Link to="/catalogs" className="text-accent-fg">All catalogs</Link>} />;

  const c = catalog.data;
  const canEdit = atLeast(c.access, 'edit');
  const canManage = c.access === 'manage';
  const sharedUnits = c.shares.filter((s) => s.subjectKind === 'unit');
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
            {c.sharedWithMe && <Badge tone="accent">Shared with you · {levelLabel[c.access === 'edit' ? 'edit' : 'view']}</Badge>}
            {c.description && <span className="text-muted">· {c.description}</span>}
          </span>
        }
        actions={
          <>
            <Button icon={canManage ? <Share2 className="size-3.5" /> : <Users className="size-3.5" />} onClick={() => setSharing(true)}>
              {canManage ? 'Share' : 'Who has access'}
              {c.shares.length > 0 && <span className="ml-1 text-muted">{c.shares.length}</span>}
            </Button>
            {canEdit && (
              <Menu trigger={<Button variant="primary" icon={<Plus className="size-3.5" />}>Add item</Button>}>
                {types
                  .filter((t) => !t.archived)
                  .map((t) => (
                    <MenuItem key={t.id} icon={<TypeIcon icon={t.icon} color={t.color} size={18} />} onSelect={() => setAdding(t)}>
                      {t.name}
                    </MenuItem>
                  ))}
              </Menu>
            )}
            {canManage && (
              <Menu trigger={<Button size="icon" aria-label="More" icon={<MoreHorizontal className="size-4" />} />}>
                <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
                  Edit catalog
                </MenuItem>
                <MenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(true)}>
                  Delete catalog
                </MenuItem>
              </Menu>
            )}
          </>
        }
      >
        {c.shares.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Share2 className="size-3" />
            Shared with
            {sharedUnits.slice(0, 4).map((s) => (
              <Badge key={s.subjectId}>{unitById.get(s.subjectId)?.name ?? 'unit'}</Badge>
            ))}
            {sharedUnits.length > 4 && <span>+{sharedUnits.length - 4} units</span>}
            {sharedPeople > 0 && <span>{sharedUnits.length ? 'and ' : ''}{sharedPeople} {sharedPeople === 1 ? 'person' : 'people'}</span>}
          </p>
        )}
      </PageHeader>
      <AssetExplorer
        fixed={{ catalogId: c.id }}
        title={c.name}
        empty={<EmptyState icon={<FolderOpen />} title="Nothing in this catalog yet" description={canEdit ? 'Add new items here, or open an existing asset and choose this catalog when editing it.' : 'Items appear here when its owners add them.'} />}
      />
      <ShareDialog catalog={c} open={sharing} onOpenChange={setSharing} />
      <CatalogFormDialog open={editing} onOpenChange={setEditing} catalog={c} />
      {adding && <AssetFormSheet open onOpenChange={(o) => !o && setAdding(null)} type={adding} catalog={c} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        danger
        title={`Delete ${c.name}?`}
        description="The catalog and its sharing are removed. Its assets are not deleted: they stay with their teams, visible as before to the organization chart only."
        confirmLabel="Delete catalog"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
