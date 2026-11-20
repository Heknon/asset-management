import cookie from '@fastify/cookie';
import { trace } from '@opentelemetry/api';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { TokenVerifier } from '../auth.js';
import { authenticate, errorResponse, notFoundBody, type RoutePolicy } from '../http.js';
import { platformMetrics } from '../telemetry/metrics.js';
import { registry } from './prom.js';

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

  // OAuth token, revocation and registration requests are form-encoded (RFC 6749); only public routes accept them.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    if (!(req.routeOptions.config as RoutePolicy | undefined)?.publicApi) return done(Object.assign(new Error('Unsupported content type'), { statusCode: 415 }), undefined);
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.addHook('onRequest', async (req) => {
    // Name the server span after the route template ("GET /api/registry/assets/:id"); no-op without tracing.
    const span = trace.getActiveSpan();
    if (span && req.routeOptions.url) {
      span.updateName(`${req.method} ${req.routeOptions.url}`);
      span.setAttribute('http.route', req.routeOptions.url);
    }
    req.principal = await authenticate(req.method, req.headers, req.cookies ?? {}, opts.verifier, (req.routeOptions.config as RoutePolicy | undefined) ?? {});
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = errorResponse(err);
    if (status >= 500) req.log.error({ err }, 'request failed');
    reply.status(status).send(body);
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send(notFoundBody);
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
