import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { principalToClaims } from '@am/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importPKCS8, SignJWT, type CryptoKey, type JWK } from 'jose';
import { createPublicKey, createPrivateKey } from 'node:crypto';
import type { PasswordHasher, TokenIssuer } from '../application/ports.js';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

/** scrypt with a per-password salt; format `scrypt$N$r$p$salt$hash`. No native modules required. */
export class ScryptHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const N = 16384, r = 8, p = 1;
    const key = await scrypt(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [alg, N, r, p, salt, hash] = stored.split('$');
    if (alg !== 'scrypt' || !N || !r || !p || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length || 32, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

/** ES256 access tokens; the public key is served as JWKS for the other services. */
export class JwtIssuer implements TokenIssuer {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicJwk: JWK,
    private readonly opts: { issuer: string; audience: string; ttlSeconds: number },
  ) {}

  static async create(pem: string | undefined, opts: { issuer: string; audience: string; ttlSeconds: number; allowEphemeral: boolean }) {
    let privateKey: CryptoKey;
    let publicJwk: JWK;
    if (pem) {
      privateKey = await importPKCS8(pem, 'ES256');
      publicJwk = await exportJWK(createPublicKey(createPrivateKey(pem)));
    } else {
      if (!opts.allowEphemeral) throw new Error('AUTH_SIGNING_KEY is required outside development');
      const pair = await generateKeyPair('ES256', { extractable: true });
      privateKey = pair.privateKey;
      publicJwk = await exportJWK(pair.publicKey);
    }
    publicJwk.kid = await calculateJwkThumbprint(publicJwk);
    publicJwk.alg = 'ES256';
    publicJwk.use = 'sig';
    return new JwtIssuer(privateKey, publicJwk, opts);
  }

  issueAccessToken(c: Parameters<TokenIssuer['issueAccessToken']>[0]): Promise<string> {
    const claims = principalToClaims({ ...c });
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: this.publicJwk.kid! })
      .setIssuer(this.opts.issuer)
      .setAudience(this.opts.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.opts.ttlSeconds}s`)
      .sign(this.privateKey);
  }

  async jwks() {
    return { keys: [this.publicJwk] };
  }

  get publicKey(): JWK {
    return this.publicJwk;
  }
}
