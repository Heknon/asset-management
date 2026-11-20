import { backupPartDoneKey, backupPieceKey, backupServices, type BackupRequested } from '@am/core';
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupService } from './application/backup-service.js';
import type { BackupStorage, ObjectStorage } from './application/ports.js';

/** Object storage in a Map, with a clock the test moves. */
function setup(start = '2026-11-20T01:00:00.000Z') {
  const objects = new Map<string, Uint8Array>();
  const published: BackupRequested[] = [];
  let now = new Date(start);
  const encode = (s: string) => new TextEncoder().encode(s);
  const storage: ObjectStorage & BackupStorage = {
    presignUpload: async () => ({ url: '', fields: {}, expiresAt: now }),
    presignDownload: async (key, o) => ({ url: `https://s3.example/${key}?rcd=${encodeURIComponent(o.disposition)}`, expiresAt: now }),
    head: async (key) => (objects.has(key) ? { size: objects.get(key)!.length, contentType: null, etag: null } : null),
    delete: async (keys) => keys.forEach((k) => objects.delete(k)),
    list: async (prefix) => [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length, modifiedAt: now })),
    read: async (key) => objects.get(key) ?? null,
    put: async (key, body) => void objects.set(key, encode(body)),
    writer: async (key) => {
      const parts: Uint8Array[] = [];
      return {
        write: async (b) => void parts.push(b),
        close: async () => void objects.set(key, new Uint8Array(Buffer.concat(parts))),
        abort: async () => undefined,
      };
    },
    presignPrefixUpload: async (prefix) => ({ url: 'https://s3.example/bucket', fields: {}, keyPrefix: prefix }),
  };
  const backups = new BackupService(storage, { origin: 'https://assets.example', schedule: '0 1 * * *', publish: async (e) => void published.push(e), now: () => now });

  /** What a service uploads for its part: its dump as lines, cut into pieces anywhere, then the marker. */
  const deliver = (request: BackupRequested, service: string, lines: unknown[], pieceChars = 40) => {
    const text = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
    let n = 0;
    for (let at = 0; at < text.length; at += pieceChars) objects.set(backupPieceKey(request.upload.keyPrefix, service, ++n), encode(text.slice(at, at + pieceChars)));
    objects.set(backupPartDoneKey(request.upload.keyPrefix, service), encode(JSON.stringify({ service, pieces: n })));
  };
  const dump = (service: string) =>
    service === 'files'
      ? [
          { format: 1, service, migrations: ['0001'] },
          { table: 'files', columns: ['id', 'status', 'size'].map((name) => ({ name, type: 'text' })) },
          ['f1', 'ready', '1000'],
          ['f2', 'pending', '5'],
          ['f3', 'ready', '24'],
          { end: true, rows: { files: 3 } },
        ]
      : [
          { format: 1, service, migrations: ['0001', '0002'] },
          { table: 'things', columns: [{ name: 'id', type: 'uuid' }, { name: 'name', type: 'text' }] },
          ['1', 'שלום, "quoted"'],
          ['2', null],
          { table: 'empty', columns: [{ name: 'id', type: 'uuid' }] },
          { end: true, rows: { things: 2, empty: 0 } },
        ];
  const complete = async (request: BackupRequested) => {
    for (const service of backupServices) {
      deliver(request, service, dump(service));
      await backups.onPart(request.backupId);
    }
  };
  return { objects, published, backups, deliver, dump, complete, setNow: (iso: string) => (now = new Date(iso)), keys: (prefix = 'backups/') => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort() };
}

const hasPython = spawnSync('python3', ['--version']).status === 0;

describe('backups in storage', () => {
  it('asks every service for its part, and shows the backup as running until all are in', async () => {
    const s = setup();
    const { id } = await s.backups.request('manual', 'Dana');
    expect(s.published).toEqual([{ backupId: id, upload: { url: 'https://s3.example/bucket', fields: {}, keyPrefix: `backups/work/${id}/` } }]);
    expect((await s.backups.status()).running).toEqual([{ id, kind: 'manual', startedAt: '2026-11-20T01:00:00.000Z', stalled: false }]);

    for (const service of backupServices.slice(0, 3)) {
      s.deliver(s.published[0]!, service, s.dump(service));
      await s.backups.onPart(id);
    }
    expect((await s.backups.status()).backups).toEqual([]);

    s.deliver(s.published[0]!, backupServices[3], s.dump(backupServices[3]));
    await s.backups.onPart(id);
    const status = await s.backups.status();
    expect(status.running).toEqual([]);
    expect(status.backups).toMatchObject([{ key: `backups/manual/2026-11-20T01-00-00Z_${id}.zip`, kind: 'manual', createdAt: '2026-11-20T01:00:00.000Z' }]);
    // The pieces are gone; a part that reports twice changes nothing.
    expect(s.keys('backups/work/')).toEqual([]);
    await s.backups.onPart(id);
    expect((await s.backups.status()).backups).toHaveLength(1);
  });

  it.skipIf(!hasPython)('puts the parts together into the same zip a downloaded backup is', async () => {
    const s = setup();
    const { id } = await s.backups.request('manual', 'Dana');
    await s.complete(s.published[0]!);
    const path = join(mkdtempSync(join(tmpdir(), 'backup-')), 'b.zip');
    writeFileSync(path, s.objects.get(`backups/manual/2026-11-20T01-00-00Z_${id}.zip`)!);
    const r = spawnSync('python3', ['-c', 'import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({"names":z.namelist(),"manifest":json.loads(z.read("manifest.json")),"things":z.read("registry/things.csv").decode("utf-8")}))', path]);
    expect(r.stderr.toString()).toBe('');
    const out = JSON.parse(r.stdout.toString());
    expect(out.names).toEqual([...backupServices.flatMap((sv) => (sv === 'files' ? ['files/files.csv'] : [`${sv}/things.csv`, `${sv}/empty.csv`])), 'manifest.json']);
    expect(out.things).toBe('﻿id,name\r\n1,"שלום, ""quoted"""\r\n2,\r\n');
    expect(out.manifest).toMatchObject({ format: 1, app: 'asset-management', createdBy: 'Dana', createdAt: '2026-11-20T01:00:00.000Z', origin: 'https://assets.example', documents: { included: false, count: 2, bytes: 1024, missing: 0 } });
    expect(out.manifest.services.registry).toEqual({ migrations: ['0001', '0002'], tables: [{ name: 'things', columns: [{ name: 'id', type: 'uuid' }, { name: 'name', type: 'text' }], rows: 2 }, { name: 'empty', columns: [{ name: 'id', type: 'uuid' }], rows: 0 }] });
  });

  it('refuses a part that was cut short, and keeps the pieces for another try', async () => {
    const s = setup();
    const { id } = await s.backups.request('manual', 'Dana');
    for (const service of backupServices) s.deliver(s.published[0]!, service, service === 'registry' ? s.dump(service).slice(0, -1) : s.dump(service));
    await expect(s.backups.onPart(id)).rejects.toThrow(/registry part .* incomplete/);
    expect((await s.backups.status()).backups).toEqual([]);
    s.deliver(s.published[0]!, 'registry', s.dump('registry'));
    await s.backups.onPart(id);
    expect((await s.backups.status()).backups).toHaveLength(1);
  });

  it('runs at night only when switched on', async () => {
    const s = setup();
    expect(await s.backups.settings()).toEqual({ nightly: false, keepDays: 3 });
    await s.backups.nightly();
    expect(s.published).toHaveLength(0);
    await s.backups.saveSettings({ nightly: true, keepDays: 3 });
    await s.backups.nightly();
    expect(s.published).toHaveLength(1);
    expect((await s.backups.status()).running[0]).toMatchObject({ kind: 'automatic' });
  });

  it('after a nightly backup, deletes automatic backups older than the days to keep, and never manual ones', async () => {
    const s = setup('2026-11-10T01:00:00.000Z');
    await s.backups.saveSettings({ nightly: true, keepDays: 3 });
    await s.backups.request('manual', 'Dana');
    await s.complete(s.published.at(-1)!);
    for (const day of ['11', '12', '13', '14', '15']) {
      s.setNow(`2026-11-${day}T01:00:00.000Z`);
      await s.backups.nightly();
      await s.complete(s.published.at(-1)!);
    }
    const left = (await s.backups.status()).backups.map((b) => `${b.kind} ${b.createdAt.slice(0, 10)}`);
    // The one from exactly three days ago is still within "three days back".
    expect(left).toEqual(['automatic 2026-11-15', 'automatic 2026-11-14', 'automatic 2026-11-13', 'automatic 2026-11-12', 'manual 2026-11-10']);
  });

  it('keeps old automatic backups while new ones are not being made', async () => {
    const s = setup('2026-11-10T01:00:00.000Z');
    await s.backups.saveSettings({ nightly: true, keepDays: 3 });
    await s.backups.nightly();
    await s.complete(s.published.at(-1)!);
    // A service is down for a week: requests go out, no backup completes, nothing is deleted.
    for (const day of ['11', '12', '13', '14', '15', '16', '17']) {
      s.setNow(`2026-11-${day}T01:00:00.000Z`);
      await s.backups.nightly();
    }
    const status = await s.backups.status();
    expect(status.backups.map((b) => b.createdAt.slice(0, 10))).toEqual(['2026-11-10']);
    // Unfinished attempts are shown as stalled, and their leftovers are removed after a day.
    expect(status.running.map((r) => [r.startedAt.slice(0, 10), r.stalled])).toEqual([['2026-11-17', false], ['2026-11-16', true]]);
  });

  it('hands out download links and deletes only real backups', async () => {
    const s = setup();
    const { id } = await s.backups.request('manual', 'Dana');
    await s.complete(s.published[0]!);
    const key = `backups/manual/2026-11-20T01-00-00Z_${id}.zip`;
    expect(decodeURIComponent((await s.backups.downloadUrl(key)).url)).toContain('attachment; filename="Assets backup 2026-11-20 0100 UTC.zip"');
    await expect(s.backups.downloadUrl('assets/a/b')).rejects.toThrow('Not a backup');
    await expect(s.backups.remove('backups/settings.json')).rejects.toThrow('Not a backup');
    await expect(s.backups.downloadUrl(key.replace(id, '00000000-0000-4000-8000-000000000000'))).rejects.toThrow(/not found/i);
    await s.backups.remove(key);
    expect((await s.backups.status()).backups).toEqual([]);
  });
});
