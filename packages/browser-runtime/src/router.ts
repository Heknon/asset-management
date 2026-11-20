import { AppError } from '@am/core';
import { authenticate, errorResponse, notFoundBody, type RoutePolicy, type TokenVerifier } from '@am/platform';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

/**
 * The part of Fastify the services' routes use, in-process: route
 * registration, params/query/body/cookies, status, headers, cookies,
 * redirects, and the same request policy as the server (CSRF check, session
 * from cookie or bearer token, error bodies). Handlers run unchanged.
 */

export interface LocalRequest {
  method: string;
  /** Path and query, e.g. /api/registry/assets?limit=50 */
  url: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body?: string;
}

export interface CookieChange {
  name: string;
  value: string | null;
  path: string;
  expires: number | null;
}

export interface LocalResponse {
  status: number;
  headers: Record<string, string>;
  cookies: CookieChange[];
  body: string | Uint8Array | ReadableStream<Uint8Array> | null;
}

type Handler = (req: RouteRequest, reply: RouteReply) => unknown;
interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  policy: RoutePolicy;
}

interface RouteRequest {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  principal: unknown;
  ip: string;
  log: Logger;
  unsignCookie(raw: string): { valid: boolean; value: string | null };
}

class RouteReply {
  statusCode = 200;
  sent = false;
  payload: unknown = undefined;
  readonly headers: Record<string, string> = {};
  readonly cookies: CookieChange[] = [];

  status(code: number) {
    this.statusCode = code;
    return this;
  }
  code(code: number) {
    return this.status(code);
  }
  header(name: string, value: string | number) {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }
  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }
  type(contentType: string) {
    return this.header('content-type', contentType);
  }
  setCookie(name: string, value: string, opts: { path?: string; maxAge?: number; expires?: Date } = {}) {
    const expires = opts.expires ? opts.expires.getTime() : opts.maxAge !== undefined ? Date.now() + opts.maxAge * 1000 : null;
    this.cookies.push({ name, value, path: opts.path ?? '/', expires });
    return this;
  }
  clearCookie(name: string, opts: { path?: string } = {}) {
    this.cookies.push({ name, value: null, path: opts.path ?? '/', expires: 0 });
    return this;
  }
  redirect(url: string, code = 302) {
    this.status(code).header('location', url);
    return this.send();
  }
  send(payload?: unknown) {
    this.sent = true;
    this.payload = payload;
    return this;
  }
}

const split = (path: string) => path.split('/').filter(Boolean);

function parseQuery(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(search)) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

export class Router {
  private readonly routes: Route[] = [];
  private verifier: TokenVerifier | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly bodyLimit = 1_048_576,
  ) {}

  /** Seen by service code as its Fastify instance. */
  asFastify(): FastifyInstance {
    const add = (method: string) => (path: string, a: unknown, b?: unknown) => {
      const handler = (typeof a === 'function' ? a : b) as Handler;
      const policy = (typeof a === 'object' && a && (a as { config?: RoutePolicy }).config) || {};
      this.routes.push({ method, segments: split(path), handler, policy });
    };
    return { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'), options: add('OPTIONS') } as unknown as FastifyInstance;
  }

  useVerifier(verifier: TokenVerifier) {
    this.verifier = verifier;
  }

  /** The most specific route wins: static segments beat parameters, as in Fastify. */
  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = split(path);
    let best: { route: Route; params: Record<string, string>; score: number } | null = null;
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let score = 0;
      const ok = route.segments.every((seg, i) => {
        if (seg.startsWith(':')) return ((params[seg.slice(1)] = decodeURIComponent(parts[i]!)), true);
        score += 1;
        return seg === parts[i];
      });
      if (ok && (!best || score > best.score)) best = { route, params, score };
    }
    return best;
  }

  async handle(input: LocalRequest): Promise<LocalResponse> {
    const url = new URL(input.url, 'http://local');
    const method = input.method.toUpperCase();
    const reply = new RouteReply();
    const log = this.logger.child({ reqId: globalThis.crypto.randomUUID(), method, url: url.pathname });
    try {
      const found = this.match(method === 'HEAD' ? 'GET' : method, url.pathname);
      if (!found) {
        reply.status(404).send(notFoundBody);
      } else {
        if (input.body && input.body.length > this.bodyLimit) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
        let body: unknown;
        if (input.body?.trim()) {
          const type = input.headers['content-type'] ?? '';
          if (found.route.policy.publicApi && /x-www-form-urlencoded/.test(type)) body = Object.fromEntries(new URLSearchParams(input.body));
          else if (!/json/.test(type)) throw Object.assign(new Error('Unsupported content type'), { statusCode: 415 });
          else
            try {
              body = JSON.parse(input.body);
            } catch {
              throw Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 });
            }
        }
        if (!this.verifier) throw new AppError('unavailable', 'Service is starting');
        const req: RouteRequest = {
          method,
          url: url.pathname + url.search,
          params: found.params,
          query: parseQuery(url.search),
          body,
          headers: input.headers,
          cookies: input.cookies,
          principal: await authenticate(method, input.headers, input.cookies, this.verifier, found.route.policy),
          ip: '127.0.0.1',
          log,
          // Signed cookies only carry the OIDC state, and directory sign-in is not available in the browser.
          unsignCookie: () => ({ valid: false, value: null }),
        };
        const returned = await found.route.handler(req, reply);
        if (!reply.sent && returned !== reply) reply.send(returned);
      }
    } catch (err) {
      const { status, body } = errorResponse(err);
      if (status >= 500) log.error({ err }, 'request failed');
      reply.status(status).send(body);
    }
    return this.serialize(reply, method);
  }

  /** Fastify's serialization: objects as JSON, strings as text, streams and bytes as they are. */
  private serialize(reply: RouteReply, method: string): LocalResponse {
    const headers: Record<string, string> = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...reply.headers };
    const p = reply.payload;
    let body: LocalResponse['body'] = null;
    if (p === undefined || p === null || reply.statusCode === 204) body = null;
    else if (typeof p === 'string') {
      headers['content-type'] ??= 'text/plain; charset=utf-8';
      body = p;
    } else if (p instanceof Uint8Array || p instanceof ReadableStream) {
      headers['content-type'] ??= 'application/octet-stream';
      body = p;
    } else {
      headers['content-type'] ??= 'application/json; charset=utf-8';
      body = JSON.stringify(p);
    }
    return { status: reply.statusCode, headers, cookies: reply.cookies, body: method === 'HEAD' ? null : body };
  }
}
