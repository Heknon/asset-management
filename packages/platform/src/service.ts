import type { FastifyInstance } from 'fastify';
import type { Migration } from 'kysely';
import { ecsFormat } from '@elastic/ecs-pino-format';
import pino, { type Logger } from 'pino';
import type { z } from 'zod';
import { createJwksVerifier, type TokenVerifier } from './auth.js';
import { loadConfig, type BaseConfig } from './config.js';
import { createDatabase, migrate, type Database } from './db.js';
import { EventBus, outboxBacklog, PgBoss, startOutboxRelay, type OutboxTable } from './events.js';
import { createHttpServer } from './http.js';
import { initMetrics, metrics, shutdownTracing, traceLogFields } from './telemetry/index.js';

export interface ServiceContext<DB, C> {
  name: string;
  config: BaseConfig & C;
  logger: Logger;
  database: Database<DB>;
  bus: EventBus;
  app: FastifyInstance;
  /** Registers cleanup to run on shutdown (reverse order). */
  onClose(fn: () => Promise<void> | void): void;
}

export interface ServiceDefinition<DB, S extends z.ZodRawShape> {
  /** Also the Postgres schema the service owns. */
  name: string;
  config: S;
  migrations: Record<string, Migration>;
  /** Defaults to verifying against the identity service's JWKS. */
  verifier?: (deps: { config: BaseConfig & z.infer<z.ZodObject<S>>; database: Database<DB> }) => Promise<TokenVerifier> | TokenVerifier;
  bodyLimit?: number;
  register(ctx: ServiceContext<DB, z.infer<z.ZodObject<S>>>): Promise<void>;
}

/**
 * One bootstrap for every service: configuration, logging, database,
 * migrations, event bus, outbox relay, HTTP, health checks and graceful
 * shutdown. `node main.js migrate` runs migrations and exits (Helm hook Job).
 */
export async function runService<DB extends OutboxTable, S extends z.ZodRawShape>(def: ServiceDefinition<DB, S>): Promise<void> {
  const config = loadConfig(def.config);
  const format = config.LOG_FORMAT;
  const logger = pino({
    ...(format === 'ecs' ? ecsFormat({ convertReqRes: true }) : {}),
    name: def.name,
    level: config.LOG_LEVEL,
    base: { service: def.name },
    // Every line carries the active trace, so logs and traces link up (Jaeger, Tempo, Elastic APM).
    mixin: () => traceLogFields(format),
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.secret'],
  });
  const database = createDatabase<DB>(config, def.name);
  const command = process.argv[2] ?? 'serve';

  if (command === 'migrate' || config.MIGRATE_ON_START) {
    const applied = await migrate(database as Database<unknown>, def.migrations);
    logger.info({ applied }, 'migrations up to date');
    if (command === 'migrate') {
      await database.close();
      return;
    }
  }

  const closers: Array<() => Promise<void> | void> = [() => shutdownTracing(), () => database.close()];
  const onClose = (fn: () => Promise<void> | void) => closers.push(fn);

  const boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: 'pgboss', ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : undefined, max: 4 });
  boss.on('error', (err) => logger.error({ err }, 'job queue error'));
  await boss.start();
  onClose(() => boss.stop({ graceful: true, timeout: 10_000 }));
  const bus = new EventBus(boss, logger);
  onClose(startOutboxRelay(database.db as never, bus, logger));

  const verifier = def.verifier
    ? await def.verifier({ config, database })
    : createJwksVerifier(required(config.AUTH_JWKS_URL, 'AUTH_JWKS_URL'), { issuer: config.AUTH_ISSUER, audience: config.AUTH_AUDIENCE });

  if (config.METRICS_ENABLED) {
    initMetrics(def.name);
    const pool = database.pool;
    metrics.gauge({
      name: 'am_db_pool_connections',
      help: 'Postgres pool connections by state',
      labelNames: ['state'],
      collect() {
        this.set({ state: 'total' }, pool.totalCount);
        this.set({ state: 'idle' }, pool.idleCount);
        this.set({ state: 'waiting' }, pool.waitingCount);
      },
    });
    metrics.gauge({
      name: 'am_outbox_pending',
      help: 'Committed events not yet relayed to the bus (should stay near 0)',
      async collect() {
        this.set(await outboxBacklog(database.db as never));
      },
    });
  }

  const app = createHttpServer({ logger, verifier, readiness: database.ping, bodyLimit: def.bodyLimit, metrics: config.METRICS_ENABLED });
  await def.register({ name: def.name, config, logger, database, bus, app, onClose });
  await app.listen({ host: config.HOST, port: config.PORT });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await app.close();
    for (const close of closers.reverse()) {
      try {
        await close();
      } catch (err) {
        logger.error({ err }, 'shutdown step failed');
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

/** Entry point wrapper so a failed boot exits non-zero with a readable error. */
export function main(start: () => Promise<void>): void {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
