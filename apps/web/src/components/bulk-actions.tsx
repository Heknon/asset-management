import type { Asset } from '@am/core';
import { Check, Download, FolderOpen, Trash2, UserRound, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { plural, t, tMaybe } from '@/lib/i18n';
import { useCatalogs, useInvalidateAssets, useLookups } from '@/lib/queries';
import { PersonPicker } from './pickers';
import { Button } from './ui/button';
import { ConfirmDialog, Menu, MenuItem, MenuSeparator, Popover } from './ui/overlay';

/** Runs `fn` for every item, a few at a time; the server still checks each item's permissions. */
async function forEach(items: Asset[], fn: (a: Asset) => Promise<unknown>) {
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const a = items[next++]!;
      try {
        await fn(a);
      } catch (e) {
        failed.push(`${a.name}: ${e instanceof ApiError ? e.message : t('failed')}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  return failed;
}

/**
 * What can be done to several items at once: status, owner, catalog, export
 * and delete. Shown while rows are selected; floats above the list.
 */
export function BulkActions({ items, onClear, onExport, extra }: { items: Asset[]; onClear: () => void; onExport: () => void; /** e.g. "Select all 80" */ extra?: React.ReactNode }) {
  const { typeById } = useLookups();
  const catalogs = useCatalogs();
  const invalidate = useInvalidateAssets();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const typeIds = new Set(items.map((a) => a.assetTypeId));
  // Statuses differ per template: offer them when every selected item shares one.
  const statuses = typeIds.size === 1 ? (typeById.get([...typeIds][0]!)?.statuses ?? []) : [];
  const n = items.length;
  const noun = plural(n, '{n} item', '{n} items');

  /** What a bulk action did: a whole sentence per action (word order differs by language). */
  type Verb = 'updated' | 'reassigned' | 'moved' | 'removed' | 'deleted';
  const doneAll: Record<Verb, () => string> = {
    updated: () => plural(n, 'Updated {n} item', 'Updated {n} items'),
    reassigned: () => plural(n, 'Reassigned {n} item', 'Reassigned {n} items'),
    moved: () => plural(n, 'Moved {n} item', 'Moved {n} items'),
    removed: () => plural(n, 'Removed {n} item from its catalog', 'Removed {n} items from their catalog'),
    deleted: () => plural(n, 'Deleted {n} item', 'Deleted {n} items'),
  };
  const doneSome: Record<Verb, (done: number) => string> = {
    updated: (done) => t('Updated {done} of {total}', { done, total: n }),
    reassigned: (done) => t('Reassigned {done} of {total}', { done, total: n }),
    moved: (done) => t('Moved {done} of {total}', { done, total: n }),
    removed: (done) => t('Removed {done} of {total} from the catalog', { done, total: n }),
    deleted: (done) => t('Deleted {done} of {total}', { done, total: n }),
  };

  const run = async (verb: Verb, fn: (a: Asset) => Promise<unknown>, clear = false) => {
    setBusy(true);
    const failed = await forEach(items, fn);
    setBusy(false);
    invalidate();
    const done = n - failed.length;
    if (failed.length) toast.error(doneSome[verb](done), { description: failed.slice(0, 3).join('\n') + (failed.length > 3 ? '\n' + t('…and {count} more', { count: failed.length - 3 }) : '') });
    else toast.success(doneAll[verb]());
    if (clear || !failed.length) onClear();
  };
  const patch = (verb: Verb, body: Record<string, unknown>) => run(verb, (a) => api.patch(`/api/registry/assets/${a.id}`, body));

  return (
    <>
      <div role="toolbar" aria-label={t('Selected items')} className="animate-panel fixed inset-x-2 flex-nowrap bottom-[calc(4rem+env(safe-area-inset-bottom))] lg:bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-3xl items-center gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-pop lg:start-64">
        <span className="px-2 text-[13px] font-medium tabular-nums">{noun}</span>
        {extra}
        <span className="mx-1 h-5 w-px bg-border max-sm:hidden" />
        {statuses.length > 0 && (
          <Menu align="start" trigger={<Button size="sm" variant="ghost" icon={<Check className="size-3.5" />} disabled={busy} aria-label={t('Status')}><span className="max-sm:sr-only">{t('Status')}</span></Button>}>
            {statuses.map((s) => (
              <MenuItem key={s.value} icon={<span className="size-2 rounded-full" style={{ background: s.color }} />} onSelect={() => void patch('updated', { status: s.value })}>
                {tMaybe(s.label)}
              </MenuItem>
            ))}
          </Menu>
        )}
        <Popover
          open={ownerOpen}
          onOpenChange={setOwnerOpen}
          className="w-72 p-3"
          trigger={
            <Button size="sm" variant="ghost" icon={<UserRound className="size-3.5" />} disabled={busy} aria-label={t('Owner')}>
              <span className="max-sm:sr-only">{t('Owner')}</span>
            </Button>
          }
        >
          <p className="mb-2 text-xs text-muted">{t('New owner for {items}', { items: noun })}</p>
          <PersonPicker
            value={null}
            placeholder={t('Choose a person')}
            onChange={(ownerId) => {
              setOwnerOpen(false);
              void patch('reassigned', { ownerId });
            }}
          />
        </Popover>
        <Menu align="start" trigger={<Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} disabled={busy} aria-label={t('Catalog')}><span className="max-sm:sr-only">{t('Catalog')}</span></Button>}>
          {(catalogs.data ?? []).filter((c) => !c.sharedWithMe).map((c) => (
            <MenuItem key={c.id} onSelect={() => void patch('moved', { catalogId: c.id })}>
              {c.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => void patch('removed', { catalogId: null })}>{t('No catalog')}</MenuItem>
        </Menu>
        <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={busy} onClick={onExport} aria-label={t('Export')}>
          <span className="max-sm:sr-only">{t('Export')}</span>
        </Button>
        <Button size="sm" variant="danger-ghost" icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={() => setDeleting(true)} aria-label={t('Delete')}>
          <span className="max-sm:sr-only">{t('Delete')}</span>
        </Button>
        <Button size="icon" variant="ghost" className="ms-auto" aria-label={t('Clear selection')} icon={<X className="size-4" />} onClick={onClear} loading={busy} />
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        danger
        title={t('Delete {items}?', { items: noun })}
        description={t('They are removed with their documents and history. Reminders for them stop. This cannot be undone.')}
        confirmLabel={t('Delete {items}', { items: noun })}
        loading={busy}
        onConfirm={() => void run('deleted', (a) => api.delete(`/api/registry/assets/${a.id}`), true).then(() => setDeleting(false))}
      />
    </>
  );
}
