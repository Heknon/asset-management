import {
  BACKUP_APP,
  BACKUP_FORMAT,
  CSV_BOM,
  backupCsvLine,
  backupDocumentPath,
  backupServices,
  backupTablePath,
  parseBackupCsv,
  type BackupManifest,
  type BackupService,
  type BackupTable,
  type ErrorBody,
  type ServiceBackupInfo,
  type SignedUrl,
  type UploadTicket,
} from '@am/core';
import { z } from 'zod';
import { api, ApiError } from './api';
import { t, tMaybe } from './i18n';
import { readZip, ZipError, ZipWriter, type ZipEntry } from './zip';

/**
 * Backup and restore, driven from the browser: every service hands out and
 * takes back only its own data, so this is where the parts become one zip,
 * and where a zip is checked, shown and sent back piece by piece.
 */

/** A problem with the file or the restore, already worded for the person. */
export class BackupError extends Error {
  constructor(
    message: string,
    /** Some of the data was already replaced when it failed. */
    readonly partial = false,
  ) {
    super(message);
  }
}

export type BackupStep = 'data' | 'documents' | 'packing' | 'copy' | 'upload' | 'checking' | 'replacing';
export interface BackupProgress {
  step: BackupStep;
  done: number;
  total: number;
}
type Report = (p: BackupProgress) => void;

const info = (service: BackupService) => api.get<ServiceBackupInfo>(`/api/${service}/backup/info`);

/** What a backup taken now would hold, per service. */
export const currentData = () => Promise.all(backupServices.map(info));

interface StoredDocument {
  id: string;
  objectKey: string;
  contentType: string;
  size: number;
}

/** The documents the `files` rows of a backup describe (finished uploads only). */
function documentsOf(columns: string[], rows: (string | null)[][]): StoredDocument[] {
  const at = (name: string) => columns.indexOf(name);
  const [id, key, type, size, status] = [at('id'), at('object_key'), at('content_type'), at('size'), at('status')];
  return rows.filter((r) => r[status] === 'ready').map((r) => ({ id: r[id]!, objectKey: r[key]!, contentType: r[type]!, size: Number(r[size]) }));
}

interface ServiceData {
  migrations: string[];
  tables: Array<BackupTable & { csv: Blob; data?: (string | null)[][] }>;
}

/** Downloads one service's data (lines of JSON, one snapshot) and turns each table into a CSV. */
async function downloadService(service: BackupService, onRows: (n: number) => void): Promise<ServiceData> {
  // The download itself cannot renew the session half-way; this call does it beforehand when needed.
  await api.get('/api/identity/me');
  const res = await fetch(`/api/${service}/backup/data`, { credentials: 'same-origin', headers: { 'x-requested-with': 'asset-management' } }).catch(() => {
    throw new ApiError(0, 'unreachable', t('Can’t reach the server'));
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => undefined)) as ErrorBody | undefined;
    throw new ApiError(res.status, body?.error.code ?? 'error', body?.error.message ? tMaybe(body.error.message) : res.statusText);
  }

  const cut = new BackupError(t('The download of the data was cut short. Try again.'));
  const tables: ServiceData['tables'] = [];
  let migrations: string[] | null = null;
  let current: { table: BackupTable; parts: string[]; data?: (string | null)[][] } | null = null;
  let finished = false;
  const close = () => {
    if (current) tables.push({ ...current.table, csv: new Blob(current.parts), data: current.data });
    current = null;
  };
  const line = (text: string) => {
    if (!text) return;
    const value = JSON.parse(text) as (string | null)[] | { migrations?: string[]; table?: string; columns?: BackupTable['columns']; end?: boolean; rows?: Record<string, number> };
    if (Array.isArray(value)) {
      if (!current) throw cut;
      current.parts.push(backupCsvLine(value));
      current.data?.push(value);
      current.table.rows++;
      if (current.table.rows % 500 === 0) onRows(500);
    } else if (value.migrations) migrations = value.migrations;
    else if (value.table && value.columns) {
      close();
      // Excel needs the byte-order mark to read UTF-8; the header names the columns.
      current = { table: { name: value.table, columns: value.columns, rows: 0 }, parts: [CSV_BOM + backupCsvLine(value.columns.map((c) => c.name))] };
      // The documents' rows are also needed here, to fetch their bytes.
      if (service === 'files' && value.table === 'files') current.data = [];
    } else if (value.end) {
      close();
      if (tables.some((tb) => tb.rows !== value.rows?.[tb.name])) throw cut;
      finished = true;
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (rest + decoder.decode(value, { stream: true })).split('\n');
      rest = lines.pop()!;
      lines.forEach(line);
    }
    line(rest + decoder.decode());
  } catch (err) {
    throw err instanceof BackupError ? err : cut;
  }
  if (!finished || !migrations) throw cut;
  return { migrations, tables };
}

export interface CreatedBackup {
  blob: Blob;
  manifest: BackupManifest;
}

/** Builds the backup file. `documents: false` leaves the documents' bytes out (their rows are always in). */
export async function createBackup({ documents, createdBy, onProgress }: { documents: boolean; createdBy: string; onProgress: Report }): Promise<CreatedBackup> {
  const zip = new ZipWriter();
  const before = await currentData();
  const total = before.reduce((n, s) => n + s.tables.reduce((m, tb) => m + tb.rows, 0), 0);
  let done = 0;
  onProgress({ step: 'data', done, total });

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    app: BACKUP_APP,
    createdAt: new Date().toISOString(),
    createdBy,
    origin: location.origin,
    services: {},
    documents: { included: documents, count: 0, bytes: 0, missing: 0 },
  };
  let stored: StoredDocument[] = [];
  for (const service of backupServices) {
    const data = await downloadService(service, (n) => onProgress({ step: 'data', done: (done += n), total: Math.max(total, done) }));
    manifest.services[service] = { migrations: data.migrations, tables: data.tables.map(({ name, columns, rows }) => ({ name, columns, rows })) };
    for (const table of data.tables) {
      await zip.add(backupTablePath(service, table.name), table.csv, { compress: true });
      if (table.data) stored = documentsOf(table.columns.map((c) => c.name), table.data);
    }
  }

  manifest.documents.count = stored.length;
  manifest.documents.bytes = stored.reduce((n, d) => n + d.size, 0);
  if (documents) {
    let copied = 0;
    for (const doc of stored) {
      onProgress({ step: 'documents', done: copied++, total: stored.length });
      const { url } = await api.get<SignedUrl>(`/api/files/backup/objects/${doc.id}/url`);
      const res = await fetch(url).catch(() => null);
      if (res?.status === 404) {
        manifest.documents.missing++;
        continue;
      }
      if (!res?.ok) throw new BackupError(t('A document could not be read from storage ({status}). Try again, or download without documents.', { status: res?.status ?? 0 }));
      await zip.add(backupDocumentPath(doc.objectKey), await res.blob());
    }
  }

  onProgress({ step: 'packing', done: 1, total: 1 });
  await zip.add('manifest.json', JSON.stringify(manifest, null, 2));
  return { blob: zip.finish(), manifest };
}

/** "Assets backup 2026-11-20 2112.zip", in local time. */
export function backupFilename(at: Date, label = 'Assets backup'): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${label} ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}${p(at.getMinutes())}.zip`;
}

const tableSchema = z.object({ name: z.string(), columns: z.array(z.object({ name: z.string(), type: z.string() })), rows: z.number().int().nonnegative() });
const manifestSchema = z.object({
  format: z.number().int(),
  app: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  origin: z.string(),
  services: z.record(z.object({ migrations: z.array(z.string()), tables: z.array(tableSchema) })),
  documents: z.object({ included: z.boolean(), count: z.number(), bytes: z.number(), missing: z.number() }),
});

export interface OpenedBackup {
  manifest: BackupManifest;
  /** Files of the backup by their path inside it (`registry/assets.csv`). */
  files: Map<string, ZipEntry>;
}

/** Reads a dropped file far enough to know it is a backup of this app, and what is in it. */
export async function openBackup(file: Blob): Promise<OpenedBackup> {
  let entries: ZipEntry[];
  try {
    entries = await readZip(file);
  } catch (err) {
    throw new BackupError(err instanceof ZipError && err.message !== 'Not a zip file' ? t('This file cannot be read: it is damaged or incomplete.') : t('This is not a backup file. Choose the .zip that “Download backup” saved.'));
  }
  // Unpacked and zipped again by hand, the files may sit inside a folder.
  const manifestEntry = entries.filter((e) => e.name === 'manifest.json' || e.name.endsWith('/manifest.json')).sort((a, b) => a.name.length - b.name.length)[0];
  const notOurs = new BackupError(t('This zip is not a backup of this app.'));
  if (!manifestEntry) throw notOurs;
  let manifest: BackupManifest;
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(await manifestEntry.text()));
    if (!parsed.success || parsed.data.app !== BACKUP_APP) throw notOurs;
    manifest = parsed.data;
  } catch (err) {
    throw err === notOurs ? notOurs : new BackupError(t('This file cannot be read: it is damaged or incomplete.'));
  }
  if (manifest.format > BACKUP_FORMAT) throw new BackupError(t('This backup was made by a newer version of the app. Upgrade this installation, then restore.'));
  const prefix = manifestEntry.name.slice(0, -'manifest.json'.length);
  return { manifest, files: new Map(entries.filter((e) => e.name.startsWith(prefix)).map((e) => [e.name.slice(prefix.length), e])) };
}

export interface RestorePreview {
  /** Why this backup cannot be restored here; empty when it can. */
  problems: string[];
  /** Rows per table, now and in the backup. */
  tables: Array<{ service: BackupService; name: string; now: number; backup: number }>;
  /** Documents the backup's rows describe whose bytes are in the file. */
  documentsInFile: number;
}

/** Compares a backup with what this installation holds now. Changes nothing. */
export async function previewRestore({ manifest, files }: OpenedBackup): Promise<RestorePreview> {
  const now = await currentData();
  const problems: string[] = [];
  const tables: RestorePreview['tables'] = [];
  backupServices.forEach((service, i) => {
    const live = now[i]!;
    const saved = manifest.services[service];
    if (!saved) return void problems.push(t('The backup is incomplete: it has no {part} data.', { part: service }));
    if (saved.migrations.join('\n') !== live.migrations.join('\n')) {
      const newer = saved.migrations.length > live.migrations.length || saved.migrations.some((m) => !live.migrations.includes(m));
      if (!problems.some((p) => p === olderVersion() || p === newerVersion())) problems.push(newer ? newerVersion() : olderVersion());
      return;
    }
    for (const table of live.tables) {
      const inBackup = saved.tables.find((tb) => tb.name === table.name);
      if (!inBackup || !files.has(backupTablePath(service, table.name))) problems.push(t('The backup is incomplete: {file} is missing.', { file: backupTablePath(service, table.name) }));
      else tables.push({ service, name: table.name, now: table.rows, backup: inBackup.rows });
    }
  });
  return { problems, tables, documentsInFile: [...files.keys()].filter((name) => name.startsWith('documents/')).length };
}

const olderVersion = () => t('This backup was made by an older version of the app. Restore it into an installation of that version, upgrade it, and take a new backup there.');
const newerVersion = () => t('This backup was made by a newer version of the app. Upgrade this installation, then restore.');

/** Rows are sent in pieces that stay well under the request size limit. */
const CHUNK_CHARS = 400_000;
const CHUNK_ROWS = 500;

/** Uploads one table's CSV into the service's staging area; returns the rows when asked to keep them. */
async function stageTable(service: BackupService, restoreId: string, table: BackupTable, entry: ZipEntry, onRows: (n: number) => void, keep: boolean): Promise<(string | null)[][]> {
  const damaged = new BackupError(t('{file} does not match the backup’s contents list. The file was changed or is damaged.', { file: backupTablePath(service, table.name) }));
  let text: string;
  try {
    text = await entry.text();
  } catch {
    throw new BackupError(t('This file cannot be read: it is damaged or incomplete.'));
  }
  const kept: (string | null)[][] = [];
  let chunk: (string | null)[][] = [];
  let chars = 0;
  let count = 0;
  const flush = async () => {
    if (!chunk.length) return;
    await api.post(`/api/${service}/backup/restore/${restoreId}/rows`, { table: table.name, rows: chunk });
    onRows(chunk.length);
    chunk = [];
    chars = 0;
  };
  let header = true;
  let rows: Generator<(string | null)[]>;
  try {
    rows = parseBackupCsv(text);
    for (const row of rows) {
      if (header) {
        header = false;
        if (row.join(',') !== table.columns.map((c) => c.name).join(',')) throw damaged;
        continue;
      }
      if (row.length !== table.columns.length) throw damaged;
      count++;
      if (keep) kept.push(row);
      chunk.push(row);
      chars += row.reduce((n, v) => n + (v?.length ?? 4) + 3, 0);
      if (chars >= CHUNK_CHARS || chunk.length >= CHUNK_ROWS) await flush();
    }
  } catch (err) {
    if (err instanceof BackupError || err instanceof ApiError) throw err;
    throw damaged;
  }
  await flush();
  if (header || count !== table.rows) throw damaged;
  return kept;
}

/** Puts a document's bytes back under its original key, unless storage still has them. */
async function restoreDocument(doc: StoredDocument, entry: ZipEntry): Promise<void> {
  const { upload } = await api.post<{ upload: UploadTicket['upload'] | null }>('/api/files/backup/objects', { objectKey: doc.objectKey, contentType: doc.contentType, size: doc.size });
  if (!upload) return;
  const form = new FormData();
  Object.entries(upload.fields).forEach(([k, v]) => form.append(k, v));
  form.append('file', await entry.blob()); // must be the last field for S3
  const res = await fetch(upload.url, { method: 'POST', body: form });
  if (!res.ok) throw new BackupError(t('Storage rejected the upload ({status})', { status: res.status }));
}

/**
 * Replaces everything with the backup's contents.
 *
 * Nothing changes while the rows are uploaded and checked; only the last
 * step replaces data, one service after the other, each all-or-nothing.
 * Every service has by then checked that it accepts its part, so a failure
 * between two of them takes a broken connection or database.
 */
export async function restoreBackup({ manifest, files }: OpenedBackup, onProgress: Report): Promise<void> {
  const total = backupServices.reduce((n, s) => n + manifest.services[s]!.tables.reduce((m, tb) => m + tb.rows, 0), 0);
  let done = 0;
  onProgress({ step: 'upload', done, total });

  const open: Array<{ service: BackupService; id: string; rows: Record<string, number> }> = [];
  let stored: StoredDocument[] = [];
  try {
    for (const service of backupServices) {
      const saved = manifest.services[service]!;
      const { id } = await api.post<{ id: string }>(`/api/${service}/backup/restore`, { migrations: saved.migrations, tables: saved.tables.map((tb) => ({ name: tb.name, columns: tb.columns.map((c) => c.name) })) });
      open.push({ service, id, rows: Object.fromEntries(saved.tables.map((tb) => [tb.name, tb.rows])) });
      for (const table of saved.tables) {
        const entry = files.get(backupTablePath(service, table.name));
        if (!entry) throw new BackupError(t('The backup is incomplete: {file} is missing.', { file: backupTablePath(service, table.name) }));
        const isDocuments = service === 'files' && table.name === 'files';
        const rows = await stageTable(service, id, table, entry, (n) => onProgress({ step: 'upload', done: (done += n), total }), isDocuments);
        if (isDocuments) stored = documentsOf(table.columns.map((c) => c.name), rows);
      }
    }

    const inFile = stored.filter((d) => files.has(backupDocumentPath(d.objectKey)));
    for (const [i, doc] of inFile.entries()) {
      onProgress({ step: 'documents', done: i, total: inFile.length });
      await restoreDocument(doc, files.get(backupDocumentPath(doc.objectKey))!);
    }

    for (const [i, s] of open.entries()) {
      onProgress({ step: 'checking', done: i, total: open.length });
      await api.post(`/api/${s.service}/backup/restore/${s.id}/check`, { rows: s.rows });
    }
  } catch (err) {
    // Nothing was replaced yet: drop what was uploaded and leave everything as it was.
    await Promise.all(open.map((s) => api.delete(`/api/${s.service}/backup/restore/${s.id}`).catch(() => undefined)));
    throw err;
  }

  for (const [i, s] of open.entries()) {
    onProgress({ step: 'replacing', done: i, total: open.length });
    try {
      await api.post(`/api/${s.service}/backup/restore/${s.id}/commit`, { rows: s.rows });
    } catch (err) {
      const reason = err instanceof Error ? err.message : '';
      if (i === 0) {
        await Promise.all(open.map((o) => api.delete(`/api/${o.service}/backup/restore/${o.id}`).catch(() => undefined)));
        throw err;
      }
      throw new BackupError(t('The restore stopped half-way ({done} of {total} parts were replaced): {reason}. Restore the same file again to finish it.', { done: i, total: open.length, reason }), true);
    }
  }
}
