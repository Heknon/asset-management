import { request } from './api';

/**
 * How the app gets its server:
 *   server   the services run on a server (OpenShift, Docker); /api is proxied to them
 *   browser  the same services run inside this browser, in a service worker
 *            with Postgres compiled to WebAssembly (VITE_RUNTIME=browser)
 */
export const runMode: 'server' | 'browser' = import.meta.env.VITE_RUNTIME === 'browser' ? 'browser' : 'server';
export const inBrowser = runMode === 'browser';

export interface RuntimeStatus {
  state: 'starting' | 'ready' | 'failed';
  step: string;
  error?: string;
}

/**
 * Registers the service worker that hosts the services and waits until it
 * controls this page and its database is up. Reports progress on the way.
 */
export async function startBrowserRuntime(onStatus: (s: RuntimeStatus) => void): Promise<void> {
  if (!('serviceWorker' in navigator)) throw new Error('This browser cannot run Assets locally (no service workers — a private window, or an old browser).');
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

  if (!navigator.serviceWorker.controller) {
    // A hard reload bypasses an already active worker for this one page load; a normal load fixes it.
    if (registration.active && !sessionStorage.getItem('am-sw-reloaded')) {
      sessionStorage.setItem('am-sw-reloaded', '1');
      location.reload();
      await new Promise(() => undefined);
    }
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  }
  sessionStorage.removeItem('am-sw-reloaded');

  await new Promise<void>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== 'runtime-status') return;
      const s = e.data.status as RuntimeStatus;
      onStatus(s);
      if (s.state === 'ready') done(resolve);
      if (s.state === 'failed') done(() => reject(new Error(s.error ?? 'The in-browser server could not start')));
    };
    const done = (fn: () => void) => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      fn();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    navigator.serviceWorker.controller!.postMessage({ type: 'runtime-start' });
  });
}

export interface SentMail {
  id: string;
  at: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  calendar: { method: 'REQUEST' | 'CANCEL'; content: string } | null;
}

export interface DemoProgress {
  state: 'idle' | 'running' | 'done' | 'failed';
  log: string[];
}

/** Extras the in-browser server offers: its mailbox, demo data, and wiping this browser's copy. */
export const localServer = {
  mail: () => request<SentMail[]>('GET', '/__local/mail'),
  demo: () => request<DemoProgress>('GET', '/__local/demo'),
  startDemo: () => request<DemoProgress>('POST', '/__local/demo'),
  reset: () => request<void>('POST', '/__local/reset'),
};
