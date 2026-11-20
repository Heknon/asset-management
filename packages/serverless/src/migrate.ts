import { migrate, type Database } from '@am/platform';
import { createDatabase, PgBoss } from '@am/platform/node';
import pg from 'pg';
import { bossOptions } from './runtime.js';
import { serviceDefinitions } from './services.js';

/**
 * Every service's migrations, each in its own schema, and the job queue's tables:
 * `bun run db:migrate:deploy` before each deploy. Applied migrations are skipped,
 * and concurrent runs wait for each other (one advisory lock around the whole run).
 */
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL_UNPOOLED');

const LOCK = 7_021_948_310;
const lock = new pg.Client({ connectionString: url });
await lock.connect();
await lock.query('select pg_advisory_lock($1)', [LOCK]);
try {
  const unused = () => {
    throw new Error('not used when migrating');
  };
  for (const def of serviceDefinitions({ mailer: unused })) {
    const database = createDatabase<unknown>({ DATABASE_URL: url, DATABASE_SSL: false, DATABASE_POOL_MAX: 1 }, def.name);
    try {
      const applied = await migrate(database as Database<unknown>, def.migrations);
      console.log(`${def.name}: ${applied.length ? applied.join(', ') : 'up to date'}`);
    } finally {
      await database.close();
    }
  }
  const boss = new PgBoss({ ...bossOptions(url, true), max: 1 });
  await boss.start();
  await boss.stop({ graceful: false, wait: true });
  console.log('pgboss: up to date');
} finally {
  await lock.query('select pg_advisory_unlock($1)', [LOCK]);
  await lock.end();
}
