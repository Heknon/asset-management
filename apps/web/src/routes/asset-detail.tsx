import { atLeast, isRestricted, type ActivityEntry, type AssetType, type FieldDefinition } from '@am/core';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, CalendarClock, History, MoreHorizontal, Pencil, Sparkles, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AssetFormSheet } from '@/components/asset-form';
import { AttributeValue } from '@/components/attribute';
import { AccessBadge, StatusBadge } from '@/components/badges';
import { Documents } from '@/components/documents';
import { ObligationList } from '@/components/obligations';
import { PersonName } from '@/components/pickers';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, SectionTitle, Spinner } from '@/components/ui/display';
import { ConfirmDialog, Menu, MenuItem } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useActivity, useAsset, useInvalidateAssets, useLookups, useMe, useObligations } from '@/lib/queries';
import { formatDateTime } from '@/lib/utils';

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

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/registry/assets/${assetId}`),
    onSuccess: () => {
      toast.success('Asset deleted');
      invalidate();
      void navigate({ to: '/assets', search: { type: asset.data?.assetTypeId } });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Delete failed'),
  });

  if (asset.isLoading || !lookups.ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!asset.data || !type) return <EmptyState title="Asset not found" description="It may have been deleted, or you may not have access." action={<Link to="/assets" className="text-accent-fg">Back to assets</Link>} />;

  const a = asset.data;
  const canEdit = atLeast(a.access, 'edit');
  const pc = lookups.classById.get(a.purchaseClassId);

  return (
    <>
      <PageHeader
        icon={<TypeIcon icon={type.icon} color={type.color} size={40} />}
        title={a.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link to="/assets" search={{ type: type.id }} className="inline-flex items-center gap-1 hover:text-fg">
              <ArrowLeft className="size-3" />
              {type.name}
            </Link>
            <StatusBadge type={type} status={a.status} />
            {pc && <Badge color={pc.color}>{pc.name}</Badge>}
            <AccessBadge level={a.access} />
          </span>
        }
        actions={
          canEdit && (
            <>
              <Button icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              {atLeast(a.access, 'manage') && (
                <Menu trigger={<Button size="icon" aria-label="More" icon={<MoreHorizontal className="size-4" />} />}>
                  <MenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(true)}>
                    Delete asset
                  </MenuItem>
                </Menu>
              )}
            </>
          )
        }
      />
      <div className="mx-auto grid w-full max-w-6xl gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Details type={type} attributes={a.attributes} ownerId={a.ownerId} canSeeRestricted={atLeast(a.access, 'manage')} />
          <Documents assetId={a.id} canEdit={canEdit} canManage={atLeast(a.access, 'manage')} currentUserId={me.userId} />
        </div>
        <div className="space-y-6">
          <KeyDates assetId={a.id} canEdit={canEdit} />
          <Activity assetId={a.id} type={type} />
        </div>
      </div>
      <AssetFormSheet open={editing} onOpenChange={setEditing} type={type} asset={a} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        danger
        title={`Delete ${a.name}?`}
        description="The asset, its documents and its reminders are removed permanently. Activity history is kept."
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

function Details({ type, attributes, ownerId, canSeeRestricted }: { type: AssetType; attributes: Record<string, unknown>; ownerId: string | null; canSeeRestricted: boolean }) {
  const sections = useMemo(() => {
    const out: Array<[string, FieldDefinition[]]> = [];
    for (const f of type.fields) {
      if (isRestricted(f) && !canSeeRestricted) continue;
      const key = f.section ?? 'Details';
      const group = out.find(([k]) => k === key);
      if (group) group[1].push(f);
      else out.push([key, [f]]);
    }
    return out;
  }, [type, canSeeRestricted]);

  return (
    <Card padded={false}>
      <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-6 gap-y-3 border-b border-border px-5 py-4 text-[13px]">
        <span className="text-muted">Owner</span>
        <PersonName id={ownerId} fallback="Unassigned" />
      </div>
      {sections.map(([section, fields]) => (
        <div key={section} className="border-b border-border px-5 py-4 last:border-0">
          <h3 className="mb-3 text-xs font-semibold tracking-wide text-subtle uppercase">{section}</h3>
          <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-6 gap-y-3 text-[13px]">
            {fields.map((f) => (
              <div key={f.key} className="contents">
                <dt className="flex items-center gap-1 text-muted">
                  {f.label}
                  {f.kind === 'date' && f.config.tracking?.derive && <Sparkles className="size-3 text-accent" aria-label="Calculated" />}
                </dt>
                <dd className="min-w-0">
                  <AttributeValue field={f} value={attributes[f.key] as never} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </Card>
  );
}

function KeyDates({ assetId, canEdit }: { assetId: string; canEdit: boolean }) {
  const active = useObligations({ assetId, state: 'active', limit: 50 });
  const history = useObligations({ assetId, state: 'done', limit: 10 });
  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <CalendarClock className="size-4 text-muted" />
        <h2 className="text-[13px] font-semibold">Key dates</h2>
      </div>
      {active.data?.items.length ? (
        <ObligationList items={active.data.items} showAsset={false} canEdit={() => canEdit} />
      ) : (
        <p className="px-4 py-6 text-center text-xs text-muted">{active.isLoading ? 'Loading…' : 'No upcoming tracked dates.'}</p>
      )}
      {!!history.data?.items.length && (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-xs font-medium text-subtle">Completed</p>
          <ul className="space-y-1.5 text-xs text-muted">
            {history.data.items.map((o) => (
              <li key={o.id} className="flex justify-between gap-2">
                <span className="truncate">
                  {o.label} · {o.dueDate}
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

const actionLabels: Record<ActivityEntry['action'], string> = { created: 'created this asset', updated: 'updated', deleted: 'deleted', advanced: 'rolled a date forward' };

function Activity({ assetId, type }: { assetId: string; type: AssetType }) {
  const activity = useActivity(assetId);
  const label = (key: string) => {
    if (key.startsWith('attributes.')) return type.fields.find((f) => f.key === key.slice(11))?.label ?? key.slice(11);
    return { name: 'Name', status: 'Status', ownerId: 'Owner', purchaseClassId: 'Purchase class', reminderOverrides: 'Reminders' }[key] ?? key;
  };
  return (
    <Card>
      <SectionTitle aside={<History className="size-4 text-subtle" />}>Activity</SectionTitle>
      <ol className="relative space-y-4 border-l border-border pl-4">
        {(activity.data ?? []).map((e) => (
          <li key={e.id} className="text-[13px]">
            <span className="absolute -left-[4.5px] mt-1.5 size-2 rounded-full border-2 border-surface bg-border-strong" />
            <p>
              <span className="font-medium">{e.actorName}</span> <span className="text-muted">{actionLabels[e.action]}</span>
            </p>
            {e.action !== 'created' && (
              <p className="mt-0.5 text-xs text-subtle">
                {Object.keys(e.changes)
                  .map(label)
                  .join(', ')}
              </p>
            )}
            <p className="mt-0.5 text-xs text-subtle">{formatDateTime(e.at)}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}
