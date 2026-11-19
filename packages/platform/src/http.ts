import cookie from '@fastify/cookie';
import { AppError, atLeast, effectiveLevel, type AccessLevel, type AccessScope, type ErrorBody, type Principal } from '@am/core';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { extractToken, type TokenVerifier } from './auth.js';
import { trace } from '@opentelemetry/api';
import { platformMetrics, registry } from './telemetry/metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface HttpOptions {
  logger: Logger;
  verifier: TokenVerifier;
  readiness: () => Promise<void>;
  cookieSecret?: string;
  bodyLimit?: number;
  /** Record request metrics and serve GET /metrics. */
  metrics?: boolean;
}

export function createHttpServer(opts: HttpOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: opts.logger as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: opts.bodyLimit ?? 1_048_576,
    disableRequestLogging: false,
    genReqId: (req) => (req.headers['x-request-id'] as string) || globalThis.crypto.randomUUID(),
  });

  app.register(cookie, { secret: opts.cookieSecret });
  app.decorateRequest('principal', null);

  // Bodies are JSON only; text/plain is a CORS "simple" type that would allow cross-site form posts.
  app.removeContentTypeParser('text/plain');
  // Empty JSON bodies (e.g. action endpoints) are treated as "no body" instead of a 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 }), undefined);
    }
  });

  app.addHook('onRequest', async (req) => {
    // Name the server span after the route template ("GET /api/registry/assets/:id"); no-op without tracing.
    const span = trace.getActiveSpan();
    if (span && req.routeOptions.url) {
      span.updateName(`${req.method} ${req.routeOptions.url}`);
      span.setAttribute('http.route', req.routeOptions.url);
    }
    // CSRF defence in depth (cookies are SameSite too): browsers cannot set custom
    // headers cross-origin without a preflight, which this API never approves.
    const unsafe = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');
    if (unsafe && !bearer && req.headers['x-requested-with'] !== 'asset-management') {
      throw AppError.forbidden('Missing X-Requested-With header');
    }
    const token = extractToken(req.headers, req.cookies ?? {});
    if (!token) return;
    try {
      req.principal = await opts.verifier.verify(token);
    } catch {
      // An invalid token is treated as anonymous; protected routes reject it via requirePrincipal().
      req.principal = null;
    }
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
  });

  app.setErrorHandler((err, req, reply) => {
    const body = toErrorBody(err);
    const status = err instanceof AppError ? err.status : body.error.code === 'validation' ? 400 : ((err as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) req.log.error({ err }, 'request failed');
    reply.status(status).send(status >= 500 ? { error: { code: 'unavailable', message: 'Internal error' } } : body);
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } } satisfies ErrorBody);
  });

  if (opts.metrics) {
    app.addHook('onResponse', async (req, reply) => {
      // Route templates (/api/registry/assets/:id), never raw URLs, keep label cardinality bounded.
      const route = req.routeOptions.url ?? 'unmatched';
      if (route === '/metrics' || route === '/healthz' || route === '/readyz') return;
      platformMetrics.http.observe({ method: req.method, route, status_code: String(reply.statusCode) }, reply.elapsedTime / 1000);
    });
    app.get('/metrics', { logLevel: 'silent' }, async (_req, reply) => {
      reply.header('content-type', registry.contentType);
      return registry.metrics();
    });
  }

  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }));
  app.get('/readyz', { logLevel: 'silent' }, async (_req, reply) => {
    try {
      await opts.readiness();
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not ready' });
    }
  });

  return app;
}

function toErrorBody(err: unknown): ErrorBody {
  if (err instanceof AppError) return { error: { code: err.code, message: err.message, details: err.details } };
  if (err instanceof ZodError) return { error: { code: 'validation', message: 'Invalid request', details: { issues: err.issues } } };
  const e = err as { validation?: unknown; message?: string; statusCode?: number };
  if (e.validation || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)) return { error: { code: 'validation', message: e.message ?? 'Invalid request' } };
  return { error: { code: 'unavailable', message: e.message ?? 'Error' } };
}

/** Parses input with a zod schema, turning failures into a 400 with field paths. */
export function parse<Out, In = Out>(schema: ZodType<Out, ZodTypeDef, In>, value: unknown): Out {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw AppError.validation('Invalid request', {
    issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw AppError.unauthenticated();
  return req.principal;
}

export function requireAdmin(req: FastifyRequest): Principal {
  const p = requirePrincipal(req);
  if (!p.isAdmin) throw AppError.forbidden('Administrator access required');
  return p;
}

/** Throws unless the principal has at least `required` on the scope; returns the effective level. */
export function authorize(principal: Principal, required: AccessLevel, scope: AccessScope): AccessLevel {
  const level = effectiveLevel(principal, scope);
  if (!atLeast(level, required)) throw required === 'view' ? AppError.notFound('Resource') : AppError.forbidden();
  return level;
}
