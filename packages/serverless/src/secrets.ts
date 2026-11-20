import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

/**
 * The token signing key and cookie secret must be the same in every function
 * instance. Unless the project sets AUTH_SIGNING_KEY and COOKIE_SECRET, they
 * are generated once and kept in the database (first writer wins).
 */
export async function sharedSecrets(db: Kysely<unknown>, env: Record<string, string | undefined>): Promise<{ AUTH_SIGNING_KEY: string; COOKIE_SECRET: string }> {
  await sql`create schema if not exists serverless`.execute(db);
  await sql`create table if not exists serverless.secrets (name text primary key, value text not null, created_at timestamptz not null default now())`.execute(db);
  const get = async (name: string, make: () => string): Promise<string> => {
    await sql`insert into serverless.secrets (name, value) values (${name}, ${make()}) on conflict (name) do nothing`.execute(db);
    const r = await sql<{ value: string }>`select value from serverless.secrets where name = ${name}`.execute(db);
    return r.rows[0]!.value;
  };
  return {
    AUTH_SIGNING_KEY:
      env.AUTH_SIGNING_KEY ??
      (await get('auth_signing_key', () => generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey)),
    COOKIE_SECRET: env.COOKIE_SECRET ?? (await get('cookie_secret', () => randomBytes(32).toString('base64url'))),
  };
}
