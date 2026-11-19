import { ecsFormat } from '@elastic/ecs-pino-format';
import pino from 'pino';
import type { z } from 'zod';
import { createJwksVerifier } from '../auth.js';
import { loadConfig } from '../config.js';
import { migrate, type Database } from '../db.js';
import { outboxBacklog, startOutboxRelay, type OutboxTable } from '../events.js';
import type { ServiceDefinition } from '../service.js';
import { shutdownTracing, traceLogFields } from '../telemetry/tracing.js';
import { PgBoss, PgBossEventBus } from './bus.js';
import { createDatabase } from './db.js';
import { createHttpServer } from './http-server.js';
import { collectedGauge, initMetrics } from './prom.js';

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
  const bus = new PgBossEventBus(boss, logger);
  onClose(startOutboxRelay(database.db as never, bus, logger));

  const verifier = def.verifier
    ? await def.verifier({ config, database })
    : createJwksVerifier(required(config.AUTH_JWKS_URL, 'AUTH_JWKS_URL'), { issuer: config.AUTH_ISSUER, audience: config.AUTH_AUDIENCE });

  if (config.METRICS_ENABLED) {
    initMetrics(def.name);
    const pool = database.pool;
    collectedGauge(
      'am_db_pool_connections',
      'Postgres pool connections by state',
      (set) => {
        set({ state: 'total' }, pool.totalCount);
        set({ state: 'idle' }, pool.idleCount);
        set({ state: 'waiting' }, pool.waitingCount);
      },
      ['state'],
    );
    collectedGauge('am_outbox_pending', 'Committed events not yet relayed to the bus (should stay near 0)', async (set) => set({}, await outboxBacklog(database.db as never)));
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
