import type { ErrorBody } from '@am/core';

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
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-requested-with': 'asset-management',
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && retry && !path.startsWith('/api/identity/auth/')) {
    if (await refreshSession()) return request<T>(method, path, body, false);
    sessionEvents.dispatchEvent(new Event('expired'));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = (data as ErrorBody | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? res.statusText, e?.details);
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
