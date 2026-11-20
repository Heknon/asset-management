import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineFilesService } from '@am/files/service';
import { nodeFilesAdapters, type NodeFilesOptions } from '@am/files/node';
import { defineIdentityService } from '@am/identity/service';
import { nodeIdentityAdapters } from '@am/identity/node';
import { createTokenVerifier, loadConfig, migrate, relayOutbox, type Database, type OutboxTable, type ServiceDefinition, type TokenVerifier } from '@am/platform';
import { createDatabase, createHttpServer, PgBoss, type PgDatabase } from '@am/platform/node';
import { defineMcpService } from '@am/mcp/service';
import { registryService } from '@am/registry/service';
import { defineSchedulerService, type Mailer } from '@am/scheduler/service';
import { nodeSchedulerAdapters } from '@am/scheduler/node';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import pino, { type Logger } from 'pino';
import type { z } from 'zod';
import { DrainEventBus } from './bus.js';
import { browserOrigins, serverlessEnvironment } from './env.js';
import { sharedSecrets } from './secrets.js';

export interface ServerlessOptions {
  /** S3 credentials from the platform (Vercel's OIDC role); otherwise keys or the default chain. */
  s3Credentials?: NodeFilesOptions['credentials'];
  /** Called with each Postgres pool (e.g. Vercel's attachDatabasePool, which closes idle connections before an instance sleeps). */
  onPool?: (pool: PgDatabase<unknown>['pool']) => void;
}

interface Service {
  name: string;
  app: FastifyInstance;
  database: PgDatabase<OutboxTable>;
}

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

/**
 * All the services in one process, for serverless platforms: the same
 * definitions the server runs, each with its own Postgres schema and Fastify
 * app (called in-process), and durable pg-boss queues that are drained after
 * each change and by the cron job instead of by always-on workers.
 */
export class ServerlessRuntime {
  private readonly services = new Map<string, Service>();
  private constructor(
    readonly env: Record<string, string | undefined>,
    private readonly boss: PgBoss,
    readonly bus: DrainEventBus,
    readonly logger: Logger,
  ) {}

  static async start(rawEnv: Record<string, string | undefined>, opts: ServerlessOptions = {}): Promise<ServerlessRuntime> {
    const base = serverlessEnvironment(rawEnv);
    const logger = pino({ level: base.LOG_LEVEL ?? 'info', base: { runtime: 'serverless' }, redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.secret'] });
    if (!base.DATABASE_URL) throw new Error('No database: connect Neon (DATABASE_URL_UNPOOLED) or set DATABASE_URL');

    // Shared secrets first: the identity service needs them before it starts.
    const bootstrap = createDatabase<unknown>({ DATABASE_URL: base.DATABASE_URL, DATABASE_SSL: false, DATABASE_POOL_MAX: 1 }, 'serverless');
    const env: Record<string, string | undefined> = { ...base, ...(await sharedSecrets(bootstrap.db, base)) };
    await bootstrap.close();

    const boss = new PgBoss({ connectionString: base.DATABASE_URL, schema: 'pgboss', max: 2, supervise: false, schedule: false, migrate: true });
    boss.on('error', (err) => logger.error({ err }, 'job queue error'));
    await boss.start();
    const runtime = new ServerlessRuntime(env, boss, new DrainEventBus(boss, logger), logger);

    const origins = browserOrigins(env);
    const definitions = [
      defineIdentityService(nodeIdentityAdapters),
      registryService,
      defineFilesService(
        nodeFilesAdapters({
          credentials: opts.s3Credentials,
          // Files asks the registry who may see an asset: in-process here.
          fetcher: (input, init) => runtime.fetch(input, init),
          // Browsers upload to and preview from the bucket directly; allow this deployment's origins once.
          onStorage: (storage) => {
            for (const origin of origins) {
              storage.allowBrowserOrigin(origin).then(
                (added) => added && logger.info({ origin }, 'allowed origin in the bucket CORS'),
                (err: unknown) => logger.warn({ err, origin }, 'could not update the bucket CORS; uploads from the browser need it (see README)'),
              );
            }
          },
        }),
      ),
      defineSchedulerService({ mailer: (config) => (rawEnv.SMTP_URL ? nodeSchedulerAdapters.mailer(config) : unconfiguredMailer(logger)) }),
      // AI assistants: tool calls reach the other services in-process, with the caller's token.
      defineMcpService({ fetcher: (input, init) => runtime.fetch(input, init) }),
    ] as unknown as Array<ServiceDefinition<OutboxTable, z.ZodRawShape>>;

    let shared: TokenVerifier | null = null;
    for (const def of definitions) {
      await runtime.startService(def, env, shared, opts.onPool);
      // Every other service verifies tokens against identity's keys, read in-process instead of over HTTP.
      if (def.name === 'identity') shared = await runtime.identityVerifier();
    }
    logger.info({ services: [...runtime.services.keys()] }, 'serverless runtime ready');
    return runtime;
  }

  private async startService(def: ServiceDefinition<OutboxTable, z.ZodRawShape>, env: Record<string, string | undefined>, shared: TokenVerifier | null, onPool?: ServerlessOptions['onPool']) {
    const config = loadConfig(def.config, env);
    const database = createDatabase<OutboxTable>(config, def.name);
    onPool?.(database.pool);
    if (config.MIGRATE_ON_START) await migrate(database as Database<unknown>, def.migrations);
    const logger = this.logger.child({ service: def.name });
    const verifier = def.verifier ? await def.verifier({ config, database }) : shared;
    if (!verifier) throw new Error(`${def.name} started before identity`);
    const app = createHttpServer({ logger, verifier, readiness: database.ping, bodyLimit: def.bodyLimit });
    await def.register({ name: def.name, config, logger, database, bus: this.bus, app, onClose: () => undefined });
    await app.ready();
    this.services.set(def.name, { name: def.name, app, database });
  }

  private async identityVerifier(): Promise<TokenVerifier> {
    const res = await this.inject({ method: 'GET', url: '/api/identity/.well-known/jwks.json' });
    const jwks = JSON.parse(res.body) as JSONWebKeySet;
    return createTokenVerifier(createLocalJWKSet(jwks), { issuer: this.env.AUTH_ISSUER ?? 'asset-management', audience: this.env.AUTH_AUDIENCE ?? 'asset-management' });
  }

  private appFor(path: string): FastifyInstance | null {
    // MCP lives at /mcp, and its sign-in discovery under /.well-known (where clients look).
    const name = path === '/mcp' || path.startsWith('/mcp/') || path.startsWith('/.well-known/oauth-protected-resource') ? 'mcp' : path.startsWith('/.well-known/oauth-authorization-server') ? 'identity' : /^\/api\/([a-z]+)(?:\/|$)/.exec(path)?.[1];
    return (name && this.services.get(name)?.app) || null;
  }

  /** A route called directly, as if over HTTP. */
  async inject(opts: InjectOptions & { url: string }) {
    const app = this.appFor(opts.url.split('?')[0]!);
    if (!app) return { statusCode: 404, headers: { 'content-type': 'application/json' } as Record<string, string | string[] | number | undefined>, body: JSON.stringify({ error: { code: 'not_found', message: 'Route not found' } }), rawPayload: Buffer.from('') };
    const r = await app.inject(opts);
    return { statusCode: r.statusCode, headers: r.headers as Record<string, string | string[] | number | undefined>, body: r.body, rawPayload: r.rawPayload };
  }

  /** `fetch` against the in-process services (calls made while handling another request). */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const r = await this.inject({
      method: request.method as InjectOptions['method'],
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      payload: request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer()),
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) for (const one of [v].flat()) headers.append(k, String(one));
    return new Response(r.statusCode === 204 || r.statusCode === 304 ? null : new Uint8Array(r.rawPayload), { status: r.statusCode, headers });
  }

  /**
   * Serves one HTTP request. Returns whether it may have changed something,
   * in which case the caller runs `settle()` (after the response is sent).
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<{ changed: boolean }> {
    const url = req.url ?? '/';
    const path = url.split('?')[0]!;
    const method = (req.method ?? 'GET').toUpperCase();
    const send = (status: number, headers: Record<string, string | string[] | number | undefined>, body: Buffer | string) => {
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers)) {
        // Fastify's inject buffers the whole body; the platform sets its own framing.
        if (v === undefined || ['transfer-encoding', 'connection', 'keep-alive', 'content-length'].includes(k.toLowerCase())) continue;
        res.setHeader(k, v as string | string[]);
      }
      res.setHeader('content-length', Buffer.byteLength(body));
      res.end(body);
    };

    if (path === '/api/cron') {
      if (!this.cronAllowed(req)) {
        const r = json(401, { error: { code: 'unauthenticated', message: 'Cron calls carry the CRON_SECRET' } });
        send(r.status, { 'content-type': 'application/json' }, r.body);
        return { changed: false };
      }
      const report = await this.cron();
      send(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify(report));
      return { changed: false };
    }
    if (path === '/api/health') {
      send(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ status: 'ok', services: [...this.services.keys()] }));
      return { changed: false };
    }

    const chunks: Buffer[] = [];
    if (method !== 'GET' && method !== 'HEAD') for await (const c of req) chunks.push(c as Buffer);
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    const r = await this.inject({
      method: method as InjectOptions['method'],
      url,
      headers: req.headers as Record<string, string>,
      payload: chunks.length ? Buffer.concat(chunks) : undefined,
      remoteAddress: forwarded || req.socket?.remoteAddress || '127.0.0.1',
    });
    send(r.statusCode, r.headers, r.rawPayload);
    return { changed: method !== 'GET' && method !== 'HEAD' && r.statusCode < 400 };
  }

  /** Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when the project has one. Without it, cron runs are open (they only do what is due). */
  private cronAllowed(req: IncomingMessage): boolean {
    const secret = this.env.CRON_SECRET;
    return !secret || req.headers.authorization === `Bearer ${secret}`;
  }

  /**
   * Delivers what a change caused, until nothing is left (or the budget runs
   * out; leftovers stay queued for the next request or cron run): publish each
   * service's outbox, run the deliveries, and repeat for what they in turn
   * caused (e.g. an asset change → the scheduler's reminders → emails).
   */
  async settle(budgetMs = 20_000): Promise<{ published: number; delivered: number }> {
    const deadline = Date.now() + budgetMs;
    let published = 0;
    let delivered = 0;
    for (let round = 0; round < 10 && Date.now() < deadline; round++) {
      let sent = 0;
      for (const s of this.services.values()) {
        let n: number;
        do sent += n = await relayOutbox(s.database.db, this.bus);
        while (n === 100 && Date.now() < deadline);
      }
      const ran = await this.bus.drain(deadline);
      published += sent;
      delivered += ran;
      if (!sent && !ran) break;
    }
    return { published, delivered };
  }

  /** The cron run: queue upkeep (retries, expired jobs), leftovers, every scheduled job (reminders, housekeeping), then what they caused. */
  async cron(): Promise<{ jobs: Record<string, 'ok' | 'failed'>; published: number; delivered: number; ms: number }> {
    const started = Date.now();
    await this.boss.maintain().catch((err: unknown) => this.logger.warn({ err }, 'queue upkeep failed'));
    const before = await this.settle(15_000);
    const jobs = await this.bus.runScheduled();
    const after = await this.settle(15_000);
    const report = { jobs, published: before.published + after.published, delivered: before.delivered + after.delivered, ms: Date.now() - started };
    this.logger.info(report, 'cron run complete');
    return report;
  }

  async close(): Promise<void> {
    for (const s of this.services.values()) {
      await s.app.close();
      await s.database.close();
    }
    await this.boss.stop({ graceful: false, wait: true });
  }
}

/** Until the project sets SMTP_URL: nothing is sent, and nothing is marked as sent, so reminders go out once mail is set up. */
function unconfiguredMailer(logger: Logger): Mailer {
  let warned = false;
  return {
    async send(message) {
      if (!warned) logger.warn('No mail provider: set SMTP_URL (and MAIL_FROM) to send reminders and notifications');
      warned = true;
      throw new Error(`Mail is not set up; not sent to ${message.to}`);
    },
  };
}
