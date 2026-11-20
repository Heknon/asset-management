import {
  AppError,
  BACKUP_APP,
  BACKUP_FORMAT,
  CSV_BOM,
  ZipStreamWriter,
  backupCsvLine,
  backupPartDoneKey,
  backupPieceKey,
  backupServices,
  backupTablePath,
  storedBackupSettingsSchema,
  type BackupColumn,
  type BackupManifest,
  type BackupRequested,
  type SignedUrl,
  type StoredBackup,
  type StoredBackupSettings,
  type StoredBackups,
} from '@am/core';
import type { BackupStorage, ObjectStorage } from './ports.js';

/**
 * Backups kept in storage: one every night when switched on, and whenever an
 * administrator asks for one.
 *
 * No service can read another's data, so a backup is made in three moves:
 * this service publishes a request carrying a form upload; every service
 * (this one included) uploads its own data as pieces and reports back; when
 * all parts are in, they are streamed into one zip, the same file "Download
 * backup" produces, without the documents, which already live in storage.
 *
 * Storage is the only record: the list of backups, the nightly setting and
 * work in progress are all objects under `backups/`. A restore therefore
 * does not change them, and a fresh installation pointed at the same bucket
 * finds the backups of the one before it.
 */

const ROOT = 'backups/';
const SETTINGS = `${ROOT}settings.json`;
const WORK = `${ROOT}work/`;
const kinds = ['automatic', 'manual'] as const;
type Kind = (typeof kinds)[number];

/** `backups/automatic/2026-11-20T01-00-07Z_<id>.zip` */
const BACKUP_KEY = /^backups\/(automatic|manual)\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z_[0-9a-f-]{36}\.zip$/;
const stamp = (at: Date) => `${at.toISOString().slice(0, 19).replace(/:/g, '-')}Z`;

const PIECE_MAX_BYTES = 64 * 1_048_576;
const UPLOAD_TTL_SECONDS = 3600;
/** After this long without finishing, a backup is shown as stalled; a day later its leftovers are removed. */
const STALLED_MS = 30 * 60_000;
const ABANDONED_MS = 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

const defaults: StoredBackupSettings = { nightly: false, keepDays: 3 };

interface Request {
  id: string;
  kind: Kind;
  createdBy: string;
  requestedAt: string;
}

export interface BackupServiceOptions {
  /** PUBLIC_URL: written into the backup as where it comes from. */
  origin: string;
  /** When the nightly backup runs (cron, UTC); shown to administrators. */
  schedule: string;
  publish(event: BackupRequested): Promise<void>;
  now?: () => Date;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

export class BackupService {
  private readonly now: () => Date;

  constructor(
    private readonly storage: ObjectStorage & BackupStorage,
    private readonly opts: BackupServiceOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async settings(): Promise<StoredBackupSettings> {
    const raw = await this.storage.read(SETTINGS);
    if (!raw) return defaults;
    const parsed = storedBackupSettingsSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
    return parsed.success ? parsed.data : defaults;
  }

  async saveSettings(settings: StoredBackupSettings): Promise<StoredBackupSettings> {
    await this.storage.put(SETTINGS, JSON.stringify(settings), 'application/json');
    return settings;
  }

  private async stored(): Promise<StoredBackup[]> {
    const objects = (await Promise.all(kinds.map((k) => this.storage.list(`${ROOT}${k}/`)))).flat();
    return objects
      .flatMap((o) => {
        const m = BACKUP_KEY.exec(o.key);
        return m ? [{ key: o.key, kind: m[1] as Kind, createdAt: `${m[2]}T${m[3]}:${m[4]}:${m[5]}.000Z`, size: o.size }] : [];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async requests(): Promise<Request[]> {
    const markers = (await this.storage.list(WORK)).filter((o) => o.key.endsWith('/request.json'));
    const out: Request[] = [];
    for (const m of markers) {
      const raw = await this.storage.read(m.key);
      if (raw) out.push(JSON.parse(new TextDecoder().decode(raw)) as Request);
    }
    return out;
  }

  async status(): Promise<StoredBackups> {
    const [settings, backups, requests] = await Promise.all([this.settings(), this.stored(), this.requests()]);
    const now = this.now().getTime();
    return {
      available: true,
      ...settings,
      schedule: this.opts.schedule,
      backups,
      running: requests
        .map((r) => ({ id: r.id, kind: r.kind, startedAt: r.requestedAt, stalled: now - Date.parse(r.requestedAt) > STALLED_MS }))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    };
  }

  /** Asks every service for its part. The backup appears in the list once all of them have delivered. */
  async request(kind: Kind, createdBy: string): Promise<{ id: string }> {
    const id = globalThis.crypto.randomUUID();
    const request: Request = { id, kind, createdBy, requestedAt: this.now().toISOString() };
    await this.storage.put(`${WORK}${id}/request.json`, JSON.stringify(request), 'application/json');
    const upload = await this.storage.presignPrefixUpload(`${WORK}${id}/`, PIECE_MAX_BYTES, UPLOAD_TTL_SECONDS);
    await this.opts.publish({ backupId: id, upload });
    this.opts.log?.({ backupId: id, kind, createdBy }, 'backup: requested');
    return { id };
  }

  /** The nightly run: tidy up what earlier runs left behind, and start a backup when it is switched on. */
  async nightly(): Promise<void> {
    await this.removeAbandoned();
    if ((await this.settings()).nightly) await this.request('automatic', 'Nightly backup');
  }

  /** A service delivered its part; when it was the last one, the zip is put together. */
  async onPart(backupId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(backupId)) return;
    const work = `${WORK}${backupId}/`;
    const raw = await this.storage.read(`${work}request.json`);
    // Already assembled (parts can report twice), or cleaned up.
    if (!raw) return;
    const request = JSON.parse(new TextDecoder().decode(raw)) as Request;

    const pieces: Record<string, number> = {};
    for (const service of backupServices) {
      const done = await this.storage.read(backupPartDoneKey(work, service));
      if (!done) return;
      pieces[service] = (JSON.parse(new TextDecoder().decode(done)) as { pieces: number }).pieces;
    }

    const key = `${ROOT}${request.kind}/${stamp(new Date(request.requestedAt))}_${request.id}.zip`;
    if (!(await this.storage.head(key))) await this.assemble(request, work, pieces, key);
    await this.removeAll(work);
    this.opts.log?.({ backupId, kind: request.kind, key }, 'backup: stored');
    if (request.kind === 'automatic') await this.prune();
  }

  /** Streams the services' parts into the zip, a table at a time; nothing larger than one piece is in memory. */
  private async assemble(request: Request, work: string, pieces: Record<string, number>, key: string): Promise<void> {
    const out = await this.storage.writer(key, 'application/zip');
    try {
      const zip = new ZipStreamWriter((bytes) => out.write(bytes), new Date(request.requestedAt));
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        app: BACKUP_APP,
        createdAt: request.requestedAt,
        createdBy: request.createdBy,
        origin: this.opts.origin,
        services: {},
        // Documents are not copied: they are in the same storage already. Their rows are in files/files.csv.
        documents: { included: false, count: 0, bytes: 0, missing: 0 },
      };

      for (const service of backupServices) {
        const incomplete = new Error(`The ${service} part of backup ${request.id} is incomplete`);
        const tables: BackupManifest['services'][string]['tables'] = [];
        let migrations: string[] | null = null;
        let finished = false;
        let entry: Awaited<ReturnType<ZipStreamWriter['entry']>> | null = null;
        let table: { name: string; columns: BackupColumn[]; rows: number } | null = null;
        let documents: { status: number; size: number } | null = null;
        let csv: string[] = [];
        let chars = 0;
        const flush = async () => {
          if (entry && csv.length) await entry.write(csv.join(''));
          csv = [];
          chars = 0;
        };
        const closeTable = async () => {
          await flush();
          await entry?.close();
          if (table) tables.push(table);
          entry = table = documents = null;
        };
        const line = async (text: string) => {
          if (!text) return;
          const value = JSON.parse(text) as (string | null)[] | { migrations?: string[]; table?: string; columns?: BackupColumn[]; end?: boolean; rows?: Record<string, number> };
          if (Array.isArray(value)) {
            if (!table) throw incomplete;
            table.rows++;
            if (documents && value[documents.status] === 'ready') {
              manifest.documents.count++;
              manifest.documents.bytes += Number(value[documents.size]);
            }
            csv.push(backupCsvLine(value));
            if ((chars += text.length) > 256_000) await flush();
          } else if (value.migrations) migrations = value.migrations;
          else if (value.table && value.columns) {
            await closeTable();
            table = { name: value.table, columns: value.columns, rows: 0 };
            entry = await zip.entry(backupTablePath(service, value.table));
            csv.push(CSV_BOM + backupCsvLine(value.columns.map((c) => c.name)));
            const names = value.columns.map((c) => c.name);
            if (service === 'files' && value.table === 'files') documents = { status: names.indexOf('status'), size: names.indexOf('size') };
          } else if (value.end) {
            await closeTable();
            if (tables.some((t) => t.rows !== value.rows?.[t.name])) throw incomplete;
            finished = true;
          }
        };

        const decoder = new TextDecoder();
        let rest = '';
        for (let n = 1; n <= pieces[service]!; n++) {
          const piece = await this.storage.read(backupPieceKey(work, service, n));
          if (!piece) throw incomplete;
          const lines = (rest + decoder.decode(piece, { stream: true })).split('\n');
          rest = lines.pop()!;
          for (const l of lines) await line(l);
        }
        await line(rest + decoder.decode());
        if (!finished || !migrations) throw incomplete;
        manifest.services[service] = { migrations, tables };
      }

      await zip.add('manifest.json', JSON.stringify(manifest, null, 2));
      await zip.finish();
      await out.close();
    } catch (err) {
      await out.abort();
      throw err;
    }
  }

  /** Deletes automatic backups older than the configured number of days. Manual ones are never deleted here. */
  async prune(): Promise<number> {
    const { keepDays } = await this.settings();
    const before = this.now().getTime() - keepDays * DAY_MS;
    const old = (await this.stored()).filter((b) => b.kind === 'automatic' && Date.parse(b.createdAt) < before);
    if (old.length) await this.storage.delete(old.map((b) => b.key));
    if (old.length) this.opts.log?.({ removed: old.map((b) => b.key), keepDays }, 'backup: removed old automatic backups');
    return old.length;
  }

  /** Pieces of backups that never finished (a service was down for a day). */
  private async removeAbandoned(): Promise<void> {
    const now = this.now().getTime();
    for (const r of await this.requests()) if (now - Date.parse(r.requestedAt) > ABANDONED_MS) await this.removeAll(`${WORK}${r.id}/`);
  }

  private async removeAll(prefix: string): Promise<void> {
    const keys = (await this.storage.list(prefix)).map((o) => o.key);
    // The request marker goes last: while it exists, a repeated report finds the work still to do.
    const marker = `${prefix}request.json`;
    const rest = keys.filter((k) => k !== marker);
    if (rest.length) await this.storage.delete(rest);
    if (keys.includes(marker)) await this.storage.delete([marker]);
  }

  private check(key: string): RegExpExecArray {
    const m = BACKUP_KEY.exec(key);
    if (!m) throw AppError.validation('Not a backup');
    return m;
  }

  /** A short-lived link that downloads the zip under a readable name. */
  async downloadUrl(key: string): Promise<SignedUrl> {
    const m = this.check(key);
    if (!(await this.storage.head(key))) throw AppError.notFound('Backup');
    const { url, expiresAt } = await this.storage.presignDownload(key, { contentType: 'application/zip', disposition: `attachment; filename="Assets backup ${m[2]} ${m[3]}${m[4]} UTC.zip"` });
    return { url, expiresAt: expiresAt.toISOString() };
  }

  async remove(key: string): Promise<void> {
    this.check(key);
    await this.storage.delete([key]);
  }
}
