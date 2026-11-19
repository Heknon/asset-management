import { randomToken } from '@am/platform';
import type { ObjectStorage } from '@am/files/service';
import { kv } from './kv.js';

interface Ticket {
  kind: 'upload' | 'download';
  key: string;
  contentType: string;
  maxBytes?: number;
  disposition?: string;
  expires: number;
}
interface StoredBlob {
  blob: Blob;
  contentType: string;
  etag: string;
}

export const STORAGE_PREFIX = '/__local/storage/';
const TTL_MS = 5 * 60_000;

async function issue(ticket: Omit<Ticket, 'expires'>): Promise<{ url: string; expiresAt: Date }> {
  const token = randomToken(24);
  const expires = Date.now() + TTL_MS;
  await kv.set('meta', `ticket:${token}`, { ...ticket, expires });
  return { url: `${STORAGE_PREFIX}${ticket.kind}/${token}`, expiresAt: new Date(expires) };
}

async function redeem(kind: Ticket['kind'], token: string): Promise<Ticket | null> {
  const t = await kv.get<Ticket>('meta', `ticket:${token}`);
  return t && t.kind === kind && t.expires > Date.now() ? t : null;
}

/**
 * Like S3 presigned URLs: the files service hands out short-lived links, and
 * the service worker serves them from IndexedDB, so the web app's upload,
 * download and preview code is the same as against S3.
 */
export const browserObjectStorage: ObjectStorage = {
  async presignUpload(key, contentType, maxBytes) {
    const { url, expiresAt } = await issue({ kind: 'upload', key, contentType, maxBytes });
    return { url, fields: {}, expiresAt };
  },
  presignDownload: (key, { contentType, disposition }) => issue({ kind: 'download', key, contentType, disposition }),
  async head(key) {
    const b = await kv.get<StoredBlob>('blobs', key);
    return b ? { size: b.blob.size, contentType: b.contentType, etag: b.etag } : null;
  },
  async delete(keys) {
    await Promise.all(keys.map((k) => kv.delete('blobs', k)));
  },
};

const text = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

/** Serves `/__local/storage/{upload|download}/{token}`: the browser's stand-in for the S3 endpoint. */
export async function serveStorage(request: Request, path: string): Promise<Response> {
  const [kind, token] = path.slice(STORAGE_PREFIX.length).split('/');
  if (kind === 'upload' && request.method === 'POST') {
    const t = await redeem('upload', token ?? '');
    if (!t) return text(403, 'Upload link expired');
    const file = (await request.formData()).get('file');
    if (!(file instanceof Blob)) return text(400, 'No file');
    if (t.maxBytes && file.size > t.maxBytes) return text(400, 'File too large');
    await kv.set('blobs', t.key, { blob: file, contentType: t.contentType, etag: randomToken(8) } satisfies StoredBlob);
    await kv.delete('meta', `ticket:${token}`);
    return new Response(null, { status: 204 });
  }
  if (kind === 'download' && (request.method === 'GET' || request.method === 'HEAD')) {
    const t = await redeem('download', token ?? '');
    if (!t) return text(403, 'Link expired');
    const stored = await kv.get<StoredBlob>('blobs', t.key);
    if (!stored) return text(404, 'Not found');
    return new Response(request.method === 'HEAD' ? null : stored.blob, {
      headers: { 'content-type': t.contentType, 'content-disposition': t.disposition ?? 'inline', 'content-length': String(stored.blob.size), 'cache-control': 'private, no-store' },
    });
  }
  return text(404, 'Not found');
}
