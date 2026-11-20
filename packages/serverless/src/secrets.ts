import { createECDH, createHash, createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

/** The order of the P-256 group: a private scalar is in [1, n-1]. */
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

/**
 * The token signing key as the identity service expects it (PKCS#8 PEM, EC P-256).
 * A PEM is used as it is; any other value is a random secret, from which the same
 * key is derived in every function instance.
 */
export function signingKeyPem(value: string): string {
  if (value.trimStart().startsWith('-----BEGIN')) return value;
  for (let counter = 0; ; counter++) {
    const d = createHash('sha256').update(`asset-management signing key ${counter}\0`).update(value).digest();
    const scalar = BigInt(`0x${d.toString('hex')}`);
    if (scalar === 0n || scalar >= P256_ORDER) continue;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    const point = ecdh.getPublicKey();
    const b64 = (b: Buffer) => b.toString('base64url');
    const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64(d), x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) }, format: 'jwk' });
    return key.export({ type: 'pkcs8', format: 'pem' }).toString();
  }
}

/**
 * The token signing key and cookie secret must be the same in every function
 * instance. Deployments receive them (AUTH_SIGNING_KEY, COOKIE_SECRET); locally,
 * whichever is unset is generated once and kept in the database (first writer wins).
 */
export async function sharedSecrets(db: Kysely<unknown> | null, env: Record<string, string | undefined>): Promise<{ AUTH_SIGNING_KEY: string; COOKIE_SECRET: string }> {
  if (env.AUTH_SIGNING_KEY && env.COOKIE_SECRET) return { AUTH_SIGNING_KEY: signingKeyPem(env.AUTH_SIGNING_KEY), COOKIE_SECRET: env.COOKIE_SECRET };
  if (env.APP_ENV || !db) throw new Error('AUTH_SIGNING_KEY and COOKIE_SECRET are required');
  await sql`create schema if not exists serverless`.execute(db);
  await sql`create table if not exists serverless.secrets (name text primary key, value text not null, created_at timestamptz not null default now())`.execute(db);
  const get = async (name: string, make: () => string): Promise<string> => {
    await sql`insert into serverless.secrets (name, value) values (${name}, ${make()}) on conflict (name) do nothing`.execute(db);
    const r = await sql<{ value: string }>`select value from serverless.secrets where name = ${name}`.execute(db);
    return r.rows[0]!.value;
  };
  return {
    AUTH_SIGNING_KEY: env.AUTH_SIGNING_KEY
      ? signingKeyPem(env.AUTH_SIGNING_KEY)
      : await get('auth_signing_key', () => generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey),
    COOKIE_SECRET: env.COOKIE_SECRET ?? (await get('cookie_secret', () => randomBytes(32).toString('base64url'))),
  };
}
