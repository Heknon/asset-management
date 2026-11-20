import type { ErrorBody } from '@am/core';
import { t, tMaybe } from './i18n';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  /** Field-level messages from registry validation (`{ fields: { key: message } }`). */
  get fieldErrors(): Record<string, string> {
    return (this.details?.fields as Record<string, string>) ?? {};
  }
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time, shared by every request that hit 401 concurrently. */
function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/identity/auth/refresh', { method: 'POST', headers: { 'x-requested-with': 'asset-management' }, credentials: 'same-origin' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => (refreshing = null), 0);
    });
  return refreshing;
}

export const sessionEvents = new EventTarget();

/**
 * The single HTTP client: same-origin cookies, CSRF header, transparent
 * session refresh, and structured errors.
 */
export async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-requested-with': 'asset-management',
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Offline, DNS, refused connection.
    throw new ApiError(0, 'unreachable', t('Can’t reach the server'));
  }
  if (res.status === 401 && retry && !path.startsWith('/api/identity/auth/')) {
    if (await refreshSession()) return request<T>(method, path, body, false);
    sessionEvents.dispatchEvent(new Event('expired'));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // Not one of our services answering (a proxy page, a static host with no API, a gateway error).
    throw new ApiError(res.status, 'unreachable', t('Can’t reach the server'));
  }
  if (!res.ok) {
    const e = (data as ErrorBody | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ? tMaybe(e.message) : res.statusText, e?.details);
  }
  return data as T;
}

/** Scalars become plain parameters; arrays/objects (e.g. filters) are sent as JSON. Empty values are omitted. */
export function withQuery(path: string, params?: object): string {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length));
  const qs = new URLSearchParams(entries.map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString();
  return qs ? `${path}?${qs}` : path;
}

export const api = {
  get: <T>(path: string, params?: object) => request<T>('GET', withQuery(path, params)),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
};

/** True when the services behind /api are not answering at all (as opposed to answering with an error). */
export const isUnreachable = (e: unknown) => e instanceof ApiError && (e.code === 'unreachable' || e.status === 502 || e.status === 503 || e.status === 504);
