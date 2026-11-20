import type { Asset } from '@am/core';
import { Check, Download, FolderOpen, Trash2, UserRound, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
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
        failed.push(`${a.name}: ${e instanceof ApiError ? e.message : 'failed'}`);
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
  const noun = `${n} ${n === 1 ? 'item' : 'items'}`;

  const run = async (verb: string, fn: (a: Asset) => Promise<unknown>, clear = false) => {
    setBusy(true);
    const failed = await forEach(items, fn);
    setBusy(false);
    invalidate();
    const done = n - failed.length;
    if (failed.length) toast.error(`${verb} ${done} of ${n}`, { description: failed.slice(0, 3).join('\n') + (failed.length > 3 ? `\n…and ${failed.length - 3} more` : '') });
    else toast.success(`${verb} ${noun}`);
    if (clear || !failed.length) onClear();
  };
  const patch = (verb: string, body: Record<string, unknown>) => run(verb, (a) => api.patch(`/api/registry/assets/${a.id}`, body));

  return (
    <>
      <div role="toolbar" aria-label="Selected items" className="animate-panel fixed inset-x-2 flex-nowrap bottom-[calc(4rem+env(safe-area-inset-bottom))] lg:bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-3xl items-center gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-pop lg:start-64">
        <span className="px-2 text-[13px] font-medium tabular-nums">{noun}</span>
        {extra}
        <span className="mx-1 h-5 w-px bg-border max-sm:hidden" />
        {statuses.length > 0 && (
          <Menu align="start" trigger={<Button size="sm" variant="ghost" icon={<Check className="size-3.5" />} disabled={busy} aria-label="Status"><span className="max-sm:sr-only">Status</span></Button>}>
            {statuses.map((s) => (
              <MenuItem key={s.value} icon={<span className="size-2 rounded-full" style={{ background: s.color }} />} onSelect={() => void patch('Updated', { status: s.value })}>
                {s.label}
              </MenuItem>
            ))}
          </Menu>
        )}
        <Popover
          open={ownerOpen}
          onOpenChange={setOwnerOpen}
          className="w-72 p-3"
          trigger={
            <Button size="sm" variant="ghost" icon={<UserRound className="size-3.5" />} disabled={busy} aria-label="Owner">
              <span className="max-sm:sr-only">Owner</span>
            </Button>
          }
        >
          <p className="mb-2 text-xs text-muted">New owner for {noun}</p>
          <PersonPicker
            value={null}
            placeholder="Choose a person"
            onChange={(ownerId) => {
              setOwnerOpen(false);
              void patch('Reassigned', { ownerId });
            }}
          />
        </Popover>
        <Menu align="start" trigger={<Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} disabled={busy} aria-label="Catalog"><span className="max-sm:sr-only">Catalog</span></Button>}>
          {(catalogs.data ?? []).filter((c) => !c.sharedWithMe).map((c) => (
            <MenuItem key={c.id} onSelect={() => void patch('Moved', { catalogId: c.id })}>
              {c.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => void patch('Removed from catalog', { catalogId: null })}>No catalog</MenuItem>
        </Menu>
        <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={busy} onClick={onExport} aria-label="Export">
          <span className="max-sm:sr-only">Export</span>
        </Button>
        <Button size="sm" variant="danger-ghost" icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={() => setDeleting(true)} aria-label="Delete">
          <span className="max-sm:sr-only">Delete</span>
        </Button>
        <Button size="icon" variant="ghost" className="ms-auto" aria-label="Clear selection" icon={<X className="size-4" />} onClick={onClear} loading={busy} />
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        danger
        title={`Delete ${noun}?`}
        description="They are removed with their documents and history. Reminders for them stop. This cannot be undone."
        confirmLabel={`Delete ${noun}`}
        loading={busy}
        onConfirm={() => void run('Deleted', (a) => api.delete(`/api/registry/assets/${a.id}`), true).then(() => setDeleting(false))}
      />
    </>
  );
}
