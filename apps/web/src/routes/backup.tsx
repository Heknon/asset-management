import type { StoredBackup, StoredBackups } from '@am/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArchiveRestore, CheckCircle2, Download, FileArchive, HardDrive, Plus, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/display';
import { Field, Input, Switch } from '@/components/ui/form';
import { ConfirmDialog, Dialog } from '@/components/ui/overlay';
import type { SignedUrl } from '@am/core';
import { api, ApiError } from '@/lib/api';
import { BackupError, backupFilename, createBackup, currentData, openBackup, previewRestore, restoreBackup, type BackupProgress, type OpenedBackup, type RestorePreview } from '@/lib/backup';
import { downloadBlob } from '@/lib/download';
import { formatNumber, plural, t } from '@/lib/i18n';
import { useMe } from '@/lib/queries';
import { cn, formatBytes, formatDateTime } from '@/lib/utils';

const messageOf = (e: unknown) => (e instanceof ApiError || e instanceof BackupError ? e.message : t('Something went wrong'));

/** The tables people recognise, in the order they care about; the rest only count towards "everything else". */
const highlights = (): Array<{ table: string; label: string }> => [
  { table: 'registry.assets', label: t('Assets') },
  { table: 'registry.asset_types', label: t('Templates') },
  { table: 'registry.requests', label: t('Requests') },
  { table: 'registry.catalogs', label: t('Catalogs') },
  { table: 'files.files', label: t('Documents') },
  { table: 'identity.users', label: t('People') },
  { table: 'identity.org_units', label: t('Organization units') },
];

function progressText(p: BackupProgress): string {
  const of = { done: formatNumber(p.done), total: formatNumber(p.total) };
  switch (p.step) {
    case 'data':
      return t('Reading the data… {done} of {total} rows', of);
    case 'documents':
      return t('Copying documents… {done} of {total}', of);
    case 'packing':
      return t('Packing the file…');
    case 'copy':
      return t('Saving a copy of the current data first…');
    case 'upload':
      return t('Uploading the backup… {done} of {total} rows', of);
    case 'checking':
      return t('Checking that everything fits…');
    case 'replacing':
      return t('Replacing the data… do not close this page');
  }
}

function ProgressBar({ progress }: { progress: BackupProgress }) {
  const part = progress.total ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <div role="status" aria-live="polite">
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.max(4, Math.round(part * 100))}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted">{progressText(progress)}</p>
    </div>
  );
}

/** Leaving the page mid-way would stop a backup or, worse, a restore; the browser asks first. */
function useLeaveWarning(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
}

export function BackupPage() {
  const me = useMe().data!;
  const data = useQuery({ queryKey: ['backup', 'current'], queryFn: currentData, retry: false, staleTime: 0, gcTime: 0 });
  const [opened, setOpened] = useState<OpenedBackup | null>(null);

  const off = data.error instanceof ApiError && data.error.status === 403;
  const rows = new Map((data.data ?? []).flatMap((s) => s.tables.map((tb) => [`${s.service}.${tb.name}`, tb.rows] as const)));
  const documents = rows.get('files.files') ?? 0;

  return (
    <>
      <PageHeader title={t('Backup & restore')} description={t('Download everything this installation stores as one zip file, and put it back when you need to.')} />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
        {off ? (
          <Card>
            <EmptyState icon={<ShieldAlert />} title={t('Backup and restore are turned off')} description={t('Whoever runs this installation turned them off (BACKUP_ENABLED=false).')} />
          </Card>
        ) : data.isError ? (
          <Card>
            <EmptyState icon={<AlertTriangle />} title={t('The data could not be read')} description={messageOf(data.error)} action={<Button onClick={() => void data.refetch()}>{t('Try again')}</Button>} />
          </Card>
        ) : (
          <>
            <DownloadCard createdBy={me.displayName} rows={rows} documents={documents} loading={data.isLoading} />
            <StoredCard onOpened={setOpened} />
            <RestoreCard onOpened={setOpened} />
          </>
        )}
      </div>
      {opened && <RestoreDialog backup={opened} createdBy={me.displayName} onClose={() => setOpened(null)} />}
    </>
  );
}

function DownloadCard({ createdBy, rows, documents, loading }: { createdBy: string; rows: Map<string, number>; documents: number; loading: boolean }) {
  const [withDocuments, setWithDocuments] = useState(true);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  useLeaveWarning(!!progress);

  const download = async () => {
    setProgress({ step: 'data', done: 0, total: 0 });
    try {
      const { blob, manifest } = await createBackup({ documents: withDocuments && documents > 0, createdBy, onProgress: setProgress });
      downloadBlob(blob, backupFilename(new Date(manifest.createdAt)));
      const missing = manifest.documents.missing;
      if (missing) toast.warning(t('Backup saved'), { description: plural(missing, '{n} document is no longer in storage and is not in the backup.', '{n} documents are no longer in storage and are not in the backup.'), duration: 15_000 });
      else toast.success(t('Backup saved'), { description: t('{size}, in your downloads folder', { size: formatBytes(blob.size) }) });
    } catch (e) {
      toast.error(t('The backup could not be made'), { description: messageOf(e), duration: 15_000 });
    } finally {
      setProgress(null);
    }
  };

  const shown = highlights().filter((h) => (rows.get(h.table) ?? 0) > 0);
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-fg">
          <Download className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">{t('Download a backup')}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{t('One zip with every table as a CSV file you can open in a spreadsheet, plus the documents.')}</p>
        </div>
      </div>

      {loading ? (
        <div className="mt-4 flex justify-center py-2">
          <Spinner />
        </div>
      ) : (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          {shown.map((h) => (
            <div key={h.table}>
              <dt className="text-xs text-muted">{h.label}</dt>
              <dd className="text-[15px] font-semibold tabular-nums">{formatNumber(rows.get(h.table)!)}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-4 border-t border-border pt-4">
        <Switch
          checked={withDocuments && documents > 0}
          onChange={setWithDocuments}
          disabled={!documents || !!progress}
          label={t('Include documents')}
          description={documents ? t('Without them the file is smaller, and a restore here still finds the documents that are in storage.') : t('There are no documents yet.')}
        />
      </div>

      <p className="mt-4 flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
        <ShieldAlert className="mt-px size-3.5 shrink-0" />
        <span>{t('The file holds everything, including license keys and other restricted fields. Keep it where only administrators can reach it.')}</span>
      </p>

      <div className="mt-4">
        {progress ? (
          <ProgressBar progress={progress} />
        ) : (
          <Button variant="primary" icon={<Download className="size-4" />} onClick={() => void download()} disabled={loading}>
            {t('Download backup')}
          </Button>
        )}
      </div>
    </Card>
  );
}

const storedKey = ['backup', 'stored'];

/** "0 1 * * *" → "01:00", and the first hour of several ("0 6,18 * * *" → "06:00"); null for anything else. */
function nightlyTime(cron: string): string | null {
  const m = /^(\d{1,2}) (\d{1,2})(?:,[\d,]+)? \* \* \*$/.exec(cron.trim());
  return m ? `${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}` : null;
}

/** Backups kept in storage: the nightly one, and the ones made here with "Back up now". */
function StoredCard({ onOpened }: { onOpened: (b: OpenedBackup) => void }) {
  const qc = useQueryClient();
  const stored = useQuery({
    queryKey: storedKey,
    queryFn: () => api.get<StoredBackups>('/api/files/backup/stored'),
    retry: false,
    // While one is being made, look again until it shows up.
    refetchInterval: (q) => (q.state.data?.running.some((r) => !r.stalled) ? 2000 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: storedKey });
  const onError = (e: unknown) => void toast.error(messageOf(e));
  const start = useMutation({ mutationFn: () => api.post('/api/files/backup/stored'), onSuccess: refresh, onError });
  const save = useMutation({
    mutationFn: (v: { nightly: boolean; keepDays: number }) => api.put('/api/files/backup/stored/settings', v),
    onSuccess: (_, v) => {
      void refresh();
      toast.success(v.nightly ? t('Nightly backup is on') : t('Nightly backup is off'));
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (b: StoredBackup) => api.delete(`/api/files/backup/stored?key=${encodeURIComponent(b.key)}`),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
    onError,
  });
  const [deleting, setDeleting] = useState<StoredBackup | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [days, setDays] = useState<string | null>(null);

  const data = stored.data;
  if (!data?.available) return null;

  const link = (b: StoredBackup) => api.get<SignedUrl>('/api/files/backup/stored/url', { key: b.key });
  const download = async (b: StoredBackup) => {
    try {
      window.location.assign((await link(b)).url);
    } catch (e) {
      onError(e);
    }
  };
  const restore = async (b: StoredBackup) => {
    setOpening(b.key);
    try {
      const res = await fetch((await link(b)).url);
      if (!res.ok) throw new BackupError(t('The backup could not be read from storage ({status}).', { status: res.status }));
      onOpened(await openBackup(await res.blob()));
    } catch (e) {
      toast.error(t('This file cannot be restored'), { description: messageOf(e), duration: 15_000 });
    } finally {
      setOpening(null);
    }
  };
  const commitDays = () => {
    const n = Number(days);
    setDays(null);
    if (days !== null && Number.isInteger(n) && n >= 1 && n <= 365 && n !== data.keepDays) save.mutate({ nightly: data.nightly, keepDays: n });
  };
  const running = data.running.filter((r) => !r.stalled);
  const stalled = data.running.filter((r) => r.stalled);

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
          <HardDrive className="size-4" />
        </div>
        <div className="min-w-0 flex-1 basis-56">
          <h2 className="text-[14px] font-semibold">{t('Backups in storage')}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{t('Kept in the same storage as the documents, so they are there even when this app is not. The documents themselves are not copied into them.')}</p>
        </div>
        <Button icon={<Plus className="size-4" />} onClick={() => start.mutate()} loading={start.isPending} disabled={running.length > 0}>
          {t('Back up now')}
        </Button>
      </div>

      <div className="flex flex-col gap-3 border-t border-border p-4">
        <Switch
          checked={data.nightly}
          onChange={(nightly) => save.mutate({ nightly, keepDays: data.keepDays })}
          disabled={save.isPending}
          label={t('Nightly backup')}
          description={
            nightlyTime(data.schedule)
              ? t('Once a day, at {time} UTC. Backups you make yourself are kept until you delete them.', { time: nightlyTime(data.schedule) })
              : t('Once a day. Backups you make yourself are kept until you delete them.')
          }
        />
        {data.nightly && (
          <label className="flex items-center gap-2 text-[13px]">
            <span>{t('Delete nightly backups after')}</span>
            <Input
              type="number"
              min={1}
              max={365}
              className="w-16"
              value={days ?? String(data.keepDays)}
              onChange={(e) => setDays(e.target.value)}
              onBlur={commitDays}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              aria-label={t('Days to keep nightly backups')}
            />
            <span>{t('days')}</span>
          </label>
        )}
      </div>

      <ul className="divide-y divide-border border-t border-border">
        {running.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-4 py-3 text-[13px] text-muted">
            <Spinner />
            {t('Making a backup…')}
          </li>
        ))}
        {stalled.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-4 py-3 text-[13px] text-danger">
            <AlertTriangle className="size-4 shrink-0" />
            {t('The backup started {when} did not finish. A service may be down; see the logs.', { when: formatDateTime(r.startedAt) })}
          </li>
        ))}
        {data.backups.map((b) => (
          <li key={b.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <div className="min-w-0 flex-1 basis-40">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {formatDateTime(b.createdAt)}
                <Badge tone={b.kind === 'automatic' ? 'neutral' : 'accent'}>{b.kind === 'automatic' ? t('Nightly') : t('Manual')}</Badge>
              </div>
              <div className="text-xs text-muted">{formatBytes(b.size)}</div>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void download(b)}>
                {t('Download')}
              </Button>
              <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => void restore(b)} loading={opening === b.key} disabled={!!opening}>
                {t('Restore…')}
              </Button>
              <Button size="icon" variant="ghost" aria-label={t('Delete')} icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(b)} />
            </div>
          </li>
        ))}
        {!data.backups.length && !data.running.length && <li className="px-4 py-6 text-center text-[13px] text-muted">{t('No backups in storage yet.')}</li>}
      </ul>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('Delete this backup?')}
        description={deleting ? t('The backup from {when} is removed from storage. This cannot be undone.', { when: formatDateTime(deleting.createdAt) }) : ''}
        confirmLabel={t('Delete')}
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Card>
  );
}

function RestoreCard({ onOpened }: { onOpened: (b: OpenedBackup) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);

  const read = async (file: File | undefined) => {
    if (!file || reading) return;
    setReading(true);
    try {
      onOpened(await openBackup(file));
    } catch (e) {
      toast.error(t('This file cannot be restored'), { description: messageOf(e), duration: 15_000 });
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Card padded={false}>
      <div className="flex items-start gap-3 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
          <ArchiveRestore className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">{t('Restore from a backup')}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{t('Replaces everything stored here with the contents of a backup file. You see what is in the file before anything changes.')}</p>
        </div>
      </div>
      <div
        onDragOver={(e) => (e.preventDefault(), setDragging(true))}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void read(e.dataTransfer.files[0]);
        }}
        className={cn('mx-4 mb-4 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center transition-colors', dragging && 'border-accent bg-accent-soft')}
      >
        {reading ? <Spinner className="size-6" /> : <FileArchive className="size-6 text-muted" />}
        <p className="text-[13px] font-medium">{t('Drop a backup .zip here')}</p>
        <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => void read(e.target.files?.[0])} />
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={reading}>
          {t('Choose a file')}
        </Button>
      </div>
    </Card>
  );
}

type RestoreState = { phase: 'review' } | { phase: 'running'; progress: BackupProgress } | { phase: 'done' } | { phase: 'failed'; message: string; partial: boolean };

function RestoreDialog({ backup, createdBy, onClose }: { backup: OpenedBackup; createdBy: string; onClose: () => void }) {
  const { manifest } = backup;
  const preview = useQuery({ queryKey: ['backup', 'preview', manifest.createdAt], queryFn: () => previewRestore(backup), retry: false, staleTime: 0, gcTime: 0 });
  const [state, setState] = useState<RestoreState>({ phase: 'review' });
  const [keepCopy, setKeepCopy] = useState(true);
  const [typed, setTyped] = useState('');
  const word = t('restore');
  const running = state.phase === 'running';
  useLeaveWarning(running);

  const blocked = !preview.data || preview.data.problems.length > 0;
  const confirmed = typed.trim().toLowerCase() === word.toLowerCase();

  const run = async () => {
    const report = (progress: BackupProgress) => setState({ phase: 'running', progress });
    report({ step: keepCopy ? 'copy' : 'upload', done: 0, total: 0 });
    try {
      if (keepCopy) {
        // Documents stay in storage through a restore, so the copy only needs the data.
        const copy = await createBackup({ documents: false, createdBy, onProgress: () => undefined });
        downloadBlob(copy.blob, backupFilename(new Date(copy.manifest.createdAt), 'Assets backup before restore'));
      }
      await restoreBackup(backup, report);
      setState({ phase: 'done' });
    } catch (e) {
      setState({ phase: 'failed', message: messageOf(e), partial: e instanceof BackupError && e.partial });
    }
  };

  /** Sessions were replaced with the backup's: start over at sign-in, with nothing cached from before. */
  const signIn = async () => {
    await api.post('/api/identity/auth/logout').catch(() => undefined);
    window.location.assign('/login');
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        // While data is being replaced, and after it was, the only way on is through the buttons.
        if (!o && state.phase !== 'running' && state.phase !== 'done') onClose();
      }}
      title={state.phase === 'done' ? t('Restore complete') : t('Restore this backup?')}
      description={state.phase === 'done' ? undefined : t('Made {when} by {who}', { when: formatDateTime(manifest.createdAt), who: manifest.createdBy })}
      footer={
        state.phase === 'review' ? (
          <>
            <Button onClick={onClose}>{t('Cancel')}</Button>
            <Button variant="danger" disabled={blocked || !confirmed} onClick={() => void run()}>
              {t('Replace everything')}
            </Button>
          </>
        ) : state.phase === 'done' ? (
          <Button variant="primary" onClick={() => void signIn()}>
            {t('Sign in again')}
          </Button>
        ) : state.phase === 'failed' ? (
          <>
            <Button onClick={onClose}>{t('Close')}</Button>
            <Button variant="primary" onClick={() => void run()}>
              {t('Try again')}
            </Button>
          </>
        ) : undefined
      }
    >
      {state.phase === 'running' ? (
        <div className="py-2">
          <ProgressBar progress={state.progress} />
        </div>
      ) : state.phase === 'done' ? (
        <div className="flex items-start gap-3 text-[13px]">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
          <p>{t('Everything was replaced with the backup from {when}. Everyone, including you, signs in again.', { when: formatDateTime(manifest.createdAt) })}</p>
        </div>
      ) : state.phase === 'failed' ? (
        <div className="flex items-start gap-3 text-[13px]">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="font-medium">{state.partial ? t('The restore did not finish') : t('Nothing was changed')}</p>
            <p className="mt-1 text-muted [overflow-wrap:anywhere]">{state.message}</p>
          </div>
        </div>
      ) : preview.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : preview.isError ? (
        <p className="text-[13px] text-danger">{messageOf(preview.error)}</p>
      ) : (
        <Review backup={backup} preview={preview.data!} keepCopy={keepCopy} onKeepCopy={setKeepCopy} word={word} typed={typed} onTyped={setTyped} />
      )}
    </Dialog>
  );
}

function Review({ backup: { manifest }, preview, keepCopy, onKeepCopy, word, typed, onTyped }: { backup: OpenedBackup; preview: RestorePreview; keepCopy: boolean; onKeepCopy: (v: boolean) => void; word: string; typed: string; onTyped: (v: string) => void }) {
  if (preview.problems.length) {
    return (
      <div className="flex items-start gap-3 text-[13px]">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="font-medium">{t('This backup cannot be restored here')}</p>
          <ul className="mt-1 list-disc space-y-1 ps-4 text-muted">
            {preview.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  const count = new Map(preview.tables.map((tb) => [`${tb.service}.${tb.name}`, tb]));
  const shown = highlights().filter((h) => count.has(h.table) && (count.get(h.table)!.now > 0 || count.get(h.table)!.backup > 0));
  const { documents } = manifest;
  const elsewhere = manifest.origin !== location.origin;
  const documentsNote = !documents.count
    ? null
    : !documents.included
      ? t('The documents themselves are not in this file. Those still in storage here keep working; the others will be listed but cannot be opened.')
      : documents.missing
        ? plural(documents.missing, '{n} document was already missing from storage when this backup was made.', '{n} documents were already missing from storage when this backup was made.')
        : t('The documents are in the file ({size}).', { size: formatBytes(documents.bytes) });

  return (
    <div className="flex flex-col gap-4 text-[13px]">
      {elsewhere && <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">{t('This backup comes from another installation: {origin}', { origin: manifest.origin })}</p>}

      <table className="w-full tabular-nums">
        <thead>
          <tr className="text-xs text-muted">
            <th className="py-1 text-start font-normal" />
            <th className="py-1 text-end font-normal">{t('Here now')}</th>
            <th className="py-1 text-end font-normal">{t('In the backup')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border border-y border-border">
          {shown.map((h) => {
            const c = count.get(h.table)!;
            return (
              <tr key={h.table}>
                <td className="py-1.5">{h.label}</td>
                <td className="py-1.5 text-end text-muted">{formatNumber(c.now)}</td>
                <td className={cn('py-1.5 text-end font-medium', c.backup < c.now && 'text-danger')}>{formatNumber(c.backup)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {documentsNote && <p className="text-xs text-muted">{documentsNote}</p>}

      <ul className="list-disc space-y-1 ps-4 text-muted">
        <li>{t('Everything stored here now is replaced. Changes made after the backup are lost.')}</li>
        <li>{t('Everyone is signed out and signs in again.')}</li>
        <li>{t('Reminders that were sent after the backup was made may be sent again.')}</li>
      </ul>

      <Switch checked={keepCopy} onChange={onKeepCopy} label={t('Save a copy of the current data first')} description={t('Downloads a backup of what is here now, so this restore can be undone. Turn it off if the current data cannot be read.')} />

      <Field label={t('Type “{word}” to confirm', { word })}>{(id) => <Input id={id} value={typed} onChange={(e) => onTyped(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />}</Field>
    </div>
  );
}
