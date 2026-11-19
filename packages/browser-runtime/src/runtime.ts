import { seedDemo, type Call } from '@am/demo-seed';
import { RegistryAssetAccess, defineFilesService } from '@am/files/service';
import { defineIdentityService } from '@am/identity/service';
import { createTokenVerifier, loadConfig, migrate, randomToken, relayOutbox, type Database, type OutboxTable, type ServiceDefinition, type TokenVerifier } from '@am/platform';
import { registryService } from '@am/registry/service';
import { defineSchedulerService } from '@am/scheduler/service';
import type { PGlite } from '@electric-sql/pglite';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import pino, { type Logger } from 'pino';
import type { z } from 'zod';
import { LOCAL_ADMIN } from './accounts.js';
import { InMemoryEventBus } from './bus.js';
import { openPglite, pgliteDatabase, type PgliteAssets } from './database.js';
import { kv } from './kv.js';
import { browserMailer } from './mailbox.js';
import { TaskQueue } from './queue.js';
import { Router, type CookieChange, type LocalRequest, type LocalResponse } from './router.js';
import { browserObjectStorage } from './storage.js';


interface Secrets {
  signingKey: string;
  cookieSecret: string;
}

/** The token signing key and cookie secret, created once per browser and kept (sessions survive restarts of the worker). */
async function secrets(): Promise<Secrets> {
  const existing = await kv.get<Secrets>('meta', 'secrets');
  if (existing) return existing;
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = btoa(Array.from(pkcs8, (b) => String.fromCharCode(b)).join('')).replace(/(.{64})/g, '$1\n');
  const created = { signingKey: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, cookieSecret: randomToken(32) };
  await kv.set('meta', 'secrets', created);
  return created;
}

/** The environment the services read their settings from: a single-user installation with local accounts and no external systems. */
function environment(origin: string, s: Secrets): Record<string, string> {
  return {
    NODE_ENV: 'production',
    LOG_LEVEL: 'warn',
    PUBLIC_URL: origin,
    DATABASE_URL: 'postgres://browser/assets',
    AUTH_JWKS_URL: `${origin}/api/identity/.well-known/jwks.json`,
    // identity
    AUTH_SIGNING_KEY: s.signingKey,
    COOKIE_SECRET: s.cookieSecret,
    LOCAL_AUTH_ENABLED: 'true',
    LOCAL_ADMIN_USERNAME: LOCAL_ADMIN.username,
    LOCAL_ADMIN_PASSWORD: LOCAL_ADMIN.password,
    LDAP_ENABLED: 'false',
    OIDC_ENABLED: 'false',
    // files: bytes stay in this browser
    S3_BUCKET: 'browser',
    MAX_UPLOAD_BYTES: String(25 * 1024 * 1024),
    REGISTRY_URL: origin,
    // scheduler: mail goes to the in-browser mailbox; reminders follow this device's time zone
    SMTP_URL: 'smtp://mailbox.local',
    MAIL_FROM: 'Asset Management <assets@mailbox.local>',
    REMINDER_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}

/** Same algorithm and output as Node's scrypt, in JavaScript. */
const scrypt = (password: string, salt: Uint8Array, dkLen: number, opts: { N: number; r: number; p: number }) => scryptAsync(password, salt, { ...opts, dkLen });

interface Service {
  name: string;
  router: Router;
  database: Database<OutboxTable>;
}

type CookieJar = Record<string, { value: string; path: string; expires: number | null }>;

/**
 * All four services, running in this browser: the same definitions the
 * server runs, on PGlite, an in-memory event bus and an in-process router.
 */
export class BrowserRuntime {
  private readonly services: Service[] = [];
  private jar: Promise<CookieJar> | null = null;
  private constructor(
    readonly pg: PGlite,
    private readonly queue: TaskQueue,
    private readonly bus: InMemoryEventBus,
    readonly logger: Logger,
  ) {}

  static async start(opts: { origin: string; assets: PgliteAssets; dataDir?: string; progress?: (step: string) => void }): Promise<BrowserRuntime> {
    const progress = opts.progress ?? (() => undefined);
    progress('Starting the database');
    const pg = await openPglite(opts.dataDir ?? 'idb://assets-management', opts.assets);
    const logger = pino({ level: 'warn', browser: { asObject: true } });
    const queue = new TaskQueue();
    let runtime: BrowserRuntime | null = null;
    const bus = new InMemoryEventBus(queue, logger, () => runtime?.relayAll() ?? Promise.resolve());
    runtime = new BrowserRuntime(pg, queue, bus, logger);
    const env = environment(opts.origin, await secrets());

    const definitions = [
      defineIdentityService({ scrypt }),
      registryService,
      defineFilesService({
        storage: () => browserObjectStorage,
        // The registry decides who may see an asset's files; reach it in-process.
        assetAccess: () => new RegistryAssetAccess(opts.origin, (input, init) => runtime!.fetch(input, init)),
      }),
      defineSchedulerService({ mailer: () => browserMailer }),
    ] as unknown as Array<ServiceDefinition<OutboxTable, z.ZodRawShape>>;

    let shared: TokenVerifier | null = null;
    for (const def of definitions) {
      progress(`Preparing ${def.name}`);
      await runtime.startService(def, env, () => shared);
      // Identity starts first; every other service verifies tokens against its keys, as on the server.
      if (def.name === 'identity') shared = await runtime.identityVerifier(env);
    }
    await runtime.relayAll();
    progress('Ready');
    return runtime;
  }

  private async startService(def: ServiceDefinition<OutboxTable, z.ZodRawShape>, env: Record<string, string>, sharedVerifier: () => TokenVerifier | null) {
    const config = loadConfig(def.config, env);
    const database = pgliteDatabase<OutboxTable>(this.pg, def.name);
    await migrate(database as Database<unknown>, def.migrations);
    const logger = this.logger.child({ service: def.name });
    const router = new Router(logger, def.bodyLimit);
    const verifier = def.verifier ? await def.verifier({ config, database }) : sharedVerifier();
    if (!verifier) throw new Error(`${def.name} started before identity`);
    router.useVerifier(verifier);
    await def.register({ name: def.name, config, logger, database, bus: this.bus, app: router.asFastify(), onClose: () => undefined });
    this.services.push({ name: def.name, router, database });
  }

  private async identityVerifier(env: Record<string, string>): Promise<TokenVerifier> {
    const res = await this.dispatch({ method: 'GET', url: '/api/identity/.well-known/jwks.json', headers: {}, cookies: {} });
    const jwks = JSON.parse(res.body as string) as JSONWebKeySet;
    return createTokenVerifier(createLocalJWKSet(jwks), { issuer: env.AUTH_ISSUER ?? 'asset-management', audience: env.AUTH_AUDIENCE ?? 'asset-management' });
  }

  /** Publishes what every service committed to its outbox, until all are empty. */
  async relayAll(): Promise<void> {
    for (const s of this.services) while ((await relayOutbox(s.database.db, this.bus)) === 100);
  }

  /** Calls a route directly (for calls made while handling another request, e.g. files asking the registry). */
  dispatch(req: LocalRequest): Promise<LocalResponse> {
    const service = /^\/api\/([a-z]+)\//.exec(req.url)?.[1];
    const target = this.services.find((s) => s.name === service);
    if (!target) return Promise.resolve({ status: 404, headers: { 'content-type': 'application/json' }, cookies: [], body: JSON.stringify({ error: { code: 'not_found', message: 'Route not found' } }) });
    return target.router.handle(req);
  }

  /** A top-level request: queued behind other work, then the events it caused are relayed. */
  handle(req: LocalRequest): Promise<LocalResponse> {
    return this.queue.run(async () => {
      const res = await this.dispatch(req);
      await this.relayAll();
      return res;
    });
  }

  /** Resolves once queued requests and the events they caused are processed. */
  idle(): Promise<void> {
    return this.queue.idle();
  }

  /** `fetch` against the in-process services (used inside a request, so not queued). */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const res = await this.dispatch({
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      cookies: {},
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    });
    return toResponse(res);
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  /** Serves a browser request with the browser's session (a cookie jar kept by the worker; responses it creates cannot set real cookies). */
  async serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.jar ??= kv.get<CookieJar>('meta', 'jar').then((j) => j ?? {});
    const jar = await this.jar;
    const res = await this.handle({
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      cookies: cookiesFor(jar, url.pathname),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    });
    if (res.cookies.length) {
      const next = applyCookies(await this.jar, res.cookies);
      this.jar = Promise.resolve(next);
      await kv.set('meta', 'jar', next);
    }
    return toResponse(res);
  }

  /** An API session of its own (the demo seed signs in as several people without touching the browser's session). */
  async session(username: string, password: string): Promise<Call> {
    let jar: CookieJar = {};
    const call: Call = async (method, path, body) => {
      const res = await this.handle({
        method,
        url: path,
        headers: { 'x-requested-with': 'asset-management', ...(body !== undefined && { 'content-type': 'application/json' }) },
        cookies: cookiesFor(jar, path.split('?')[0]!),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      jar = applyCookies(jar, res.cookies);
      const text = typeof res.body === 'string' ? res.body : res.body ? await new Response(res.body as unknown as BodyInit).text() : '';
      if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text}`);
      return text ? JSON.parse(text) : undefined;
    };
    await call('POST', '/api/identity/auth/login', { provider: 'local', username, password });
    return call;
  }

  /** Fills this browser with the demo company. */
  seedDemo(log: (message: string) => void): Promise<void> {
    return seedDemo({ admin: LOCAL_ADMIN, login: (u, p) => this.session(u, p), settle: () => this.idle(), log });
  }

  async close(): Promise<void> {
    this.bus.stop();
    await this.idle();
    await this.pg.close();
  }
}

function cookiesFor(jar: CookieJar, path: string): Record<string, string> {
  const now = Date.now();
  return Object.fromEntries(Object.entries(jar).filter(([, c]) => (c.expires === null || c.expires > now) && path.startsWith(c.path)).map(([name, c]) => [name, c.value]));
}

function applyCookies(jar: CookieJar, changes: CookieChange[]): CookieJar {
  const next = { ...jar };
  for (const c of changes) {
    if (c.value === null || (c.expires !== null && c.expires <= Date.now())) delete next[c.name];
    else next[c.name] = { value: c.value, path: c.path, expires: c.expires };
  }
  return next;
}

function toResponse(res: LocalResponse): Response {
  const noBody = res.status === 204 || res.status === 304;
  return new Response(noBody ? null : (res.body as unknown as BodyInit | null), { status: res.status, headers: res.headers });
}
