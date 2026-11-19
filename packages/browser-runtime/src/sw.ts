/// <reference lib="webworker" />
import { deleteRuntimeStores, kv } from './kv.js';
import { sentMail } from './mailbox.js';
import { BrowserRuntime } from './runtime.js';
import { serveStorage, STORAGE_PREFIX } from './storage.js';

/**
 * The service worker is the browser runtime's "server": it answers every
 * same-origin request to /api/* (and the storage links the files service
 * hands out) from the services running inside it. Pages, links, downloads and
 * previews in the web app work exactly as against a real server.
 */
declare const self: ServiceWorkerGlobalScope;
/** Folder with the PGlite binaries, set at build time. */
declare const __PGLITE_DIR__: string;

const DATA_DIR = 'idb://assets-management';

type Status = { state: 'starting' | 'ready' | 'failed'; step: string; error?: string };
let status: Status = { state: 'starting', step: 'Waiting' };
let runtime: Promise<BrowserRuntime> | null = null;

const broadcast = async (s: Status) => {
  status = s;
  for (const client of await self.clients.matchAll({ includeUncontrolled: true })) client.postMessage({ type: 'runtime-status', status: s });
};

function start(): Promise<BrowserRuntime> {
  return (runtime ??= BrowserRuntime.start({
    origin: self.location.origin,
    assets: { baseUrl: new URL(__PGLITE_DIR__, self.location.origin).href },
    dataDir: DATA_DIR,
    progress: (step) => void broadcast({ state: step === 'Ready' ? 'ready' : 'starting', step }),
  }).catch((err) => {
    runtime = null;
    void broadcast({ state: 'failed', step: 'Could not start', error: String((err as Error)?.message ?? err) });
    throw err;
  }));
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const unavailable = (err: unknown) => json(503, { error: { code: 'unavailable', message: `The in-browser server could not start: ${(err as Error)?.message ?? err}` } });

// ─── Demo data, mailbox, reset ───────────────────────────────────────────────

let demo: { state: 'idle' | 'running' | 'done' | 'failed'; log: string[] } = { state: 'idle', log: [] };

async function local(request: Request, path: string): Promise<Response> {
  const unsafe = request.method !== 'GET';
  if (unsafe && request.headers.get('x-requested-with') !== 'asset-management') return json(403, { error: { code: 'forbidden', message: 'Missing X-Requested-With header' } });
  switch (`${request.method} ${path}`) {
    case 'GET /__local/status':
      return json(200, { ...status, mode: 'browser' });
    case 'GET /__local/mail':
      return json(200, await sentMail());
    case 'GET /__local/demo':
      // Remembered across restarts of the worker.
      return json(200, demo.state === 'idle' && (await kv.get('meta', 'demo')) === 'done' ? { state: 'done', log: [] } : demo);
    case 'POST /__local/demo': {
      if (demo.state === 'running') return json(202, demo);
      demo = { state: 'running', log: [] };
      const rt = await start();
      // The seed runs in the background; the page polls GET /__local/demo.
      void rt
        .seedDemo((m) => demo.log.push(m))
        .then(async () => {
          await kv.set('meta', 'demo', 'done');
          demo.state = 'done';
        })
        .catch((err) => {
          demo.state = 'failed';
          demo.log.push(String((err as Error)?.message ?? err));
        });
      return json(202, demo);
    }
    case 'POST /__local/reset': {
      const rt = runtime;
      runtime = null;
      demo = { state: 'idle', log: [] };
      if (rt) await (await rt.catch(() => null))?.close();
      // Everything this app keeps in the browser: the database and the runtime's own stores.
      const dbs = (await indexedDB.databases?.()) ?? [];
      await Promise.all(dbs.filter((d) => d.name && /pglite|assets-management/.test(d.name)).map((d) => new Promise((r) => { const q = indexedDB.deleteDatabase(d.name!); q.onsuccess = q.onerror = q.onblocked = r; })));
      await deleteRuntimeStores();
      void broadcast({ state: 'starting', step: 'Waiting' });
      return new Response(null, { status: 204 });
    }
    default:
      return json(404, { error: { code: 'not_found', message: 'Route not found' } });
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith('/api/')) {
    event.respondWith(
      start()
        .then(async (rt) => {
          const res = await rt.serve(event.request);
          // Keep the worker alive until the events this request caused are delivered.
          event.waitUntil(rt.idle());
          return res;
        })
        .catch(unavailable),
    );
  } else if (path.startsWith(STORAGE_PREFIX)) {
    event.respondWith(serveStorage(event.request, path));
  } else if (path.startsWith('/__local/')) {
    event.respondWith(local(event.request, path).catch((err) => json(500, { error: { code: 'unavailable', message: String(err) } })));
  }
});

// Pages ask the worker to start as soon as it controls them, so the database is warm by the first request.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string })?.type === 'runtime-start') {
    event.waitUntil(
      start()
        .then(() => broadcast({ state: 'ready', step: 'Ready' }))
        .catch(() => undefined),
    );
  }
});
