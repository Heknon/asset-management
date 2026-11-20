import { roles, type AccessCheck, type Permission, type Principal } from '@am/core';
import { describe, expect, it } from 'bun:test';
import { FileService } from './application/file-service.js';
import type { AssetAccess, FileStore, ObjectStorage } from './application/ports.js';
import { contentDisposition, type StoredFile } from './domain/file.js';

const ASSET = '11111111-1111-4111-8111-111111111111';
const principal = (userId: string): Principal => ({ userId, username: userId, displayName: userId, email: null, isAdmin: false, grants: [], units: [] });

function setup(permissions: readonly Permission[] = roles.editor.permissions) {
  const rows = new Map<string, StoredFile>();
  const objects = new Map<string, { size: number; contentType: string }>();
  const store: FileStore = {
    insert: async (f) => {
      const row = { ...f, createdAt: new Date() };
      rows.set(f.id, row);
      return row;
    },
    get: async (id) => rows.get(id) ?? null,
    listByAsset: async (a) => [...rows.values()].filter((r) => r.assetId === a),
    markReady: async (id, etag) => {
      const r = { ...rows.get(id)!, status: 'ready' as const, etag };
      rows.set(id, r);
      return r;
    },
    delete: async (id) => void rows.delete(id),
    deleteByAsset: async (a) => {
      const gone = [...rows.values()].filter((r) => r.assetId === a);
      gone.forEach((r) => rows.delete(r.id));
      return gone;
    },
    stalePending: async () => [],
  };
  const storage: ObjectStorage = {
    presignUpload: async (key, contentType, max) => ({ url: 'https://s3.example/bucket', fields: { key, 'Content-Type': contentType, max: String(max) }, expiresAt: new Date() }),
    presignDownload: async (key, o) => ({ url: `https://s3.example/${key}?rcd=${encodeURIComponent(o.disposition)}`, expiresAt: new Date() }),
    head: async (key) => {
      const o = objects.get(key);
      return o ? { ...o, etag: '"e"' } : null;
    },
    delete: async (keys) => keys.forEach((k) => objects.delete(k)),
  };
  const access: AssetAccess = { check: async (_t, id): Promise<AccessCheck | null> => (id === ASSET && permissions.length ? { assetId: id, assetTypeId: 't', unitId: 'p', catalogId: null, permissions: [...permissions] } : null) };
  return { service: new FileService(store, storage, access, 10_000), objects, rows };
}

const caller = (id = 'u1') => ({ principal: principal(id), token: 't' });

describe('FileService', () => {
  it('issues a pinned presigned upload and confirms it against storage', async () => {
    const { service, objects } = setup();
    const ticket = await service.requestUpload(caller(), { assetId: ASSET, filename: '../../Order form.pdf', contentType: 'application/pdf', size: 1234 });
    expect(ticket.file.filename).toBe('Order form.pdf');
    expect(ticket.upload.fields.key).toBe(`assets/${ASSET}/${ticket.file.id}`);
    expect(ticket.upload.fields.max).toBe('1234');
    await expect(service.completeUpload(caller(), ticket.file.id)).rejects.toThrow(/not reached storage/);
    objects.set(ticket.upload.fields.key!, { size: 1234, contentType: 'application/pdf' });
    expect((await service.completeUpload(caller(), ticket.file.id)).status).toBe('ready');
  });

  it('rejects disallowed types, oversize files and mismatched uploads', async () => {
    const { service, objects, rows } = setup();
    await expect(service.requestUpload(caller(), { assetId: ASSET, filename: 'x.html', contentType: 'text/html', size: 10 })).rejects.toThrow(/not allowed/);
    await expect(service.requestUpload(caller(), { assetId: ASSET, filename: 'x.pdf', contentType: 'application/pdf', size: 20_000 })).rejects.toThrow(/smaller/);
    const t = await service.requestUpload(caller(), { assetId: ASSET, filename: 'x.pdf', contentType: 'application/pdf', size: 100 });
    objects.set(t.upload.fields.key!, { size: 999, contentType: 'application/pdf' });
    await expect(service.completeUpload(caller(), t.file.id)).rejects.toThrow(/does not match/);
    expect(rows.size).toBe(0);
  });

  it('enforces asset permissions', async () => {
    await expect(setup(roles.commenter.permissions).service.requestUpload(caller(), { assetId: ASSET, filename: 'a.pdf', contentType: 'application/pdf', size: 1 })).rejects.toThrow(/Add documents/);
    await setup(roles.contributor.permissions).service.requestUpload(caller(), { assetId: ASSET, filename: 'a.pdf', contentType: 'application/pdf', size: 1 });
    await expect(setup([]).service.list(caller(), ASSET)).rejects.toThrow(/not found/);
  });

  it('previews inline only for previewable types', async () => {
    const { service, objects } = setup();
    const t = await service.requestUpload(caller(), { assetId: ASSET, filename: 'Contract.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 5 });
    objects.set(t.upload.fields.key!, { size: 5, contentType: t.file.contentType });
    await service.completeUpload(caller(), t.file.id);
    const { url } = await service.signedUrl(caller(), t.file.id, 'preview');
    expect(decodeURIComponent(url)).toContain('attachment;');
  });

  it('only lets the uploader or someone with Delete remove a file', async () => {
    const { service, objects } = setup();
    const t = await service.requestUpload(caller('u1'), { assetId: ASSET, filename: 'a.pdf', contentType: 'application/pdf', size: 1 });
    objects.set(t.upload.fields.key!, { size: 1, contentType: 'application/pdf' });
    await service.completeUpload(caller('u1'), t.file.id);
    await expect(service.remove(caller('u2'), t.file.id)).rejects.toThrow(/uploaded it/);
    await service.remove(caller('u1'), t.file.id);
  });

  it('encodes non-ASCII filenames per RFC 6266', () => {
    expect(contentDisposition('Überweisung "Q1".pdf', true)).toBe(`inline; filename="_berweisung _Q1_.pdf"; filename*=UTF-8''%C3%9Cberweisung%20%22Q1%22.pdf`);
  });
});
