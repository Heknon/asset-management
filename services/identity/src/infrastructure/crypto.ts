import { constantTimeEqual, fromBase64Url, principalToClaims, toBase64Url } from '@am/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importPKCS8, SignJWT, type CryptoKey, type JWK } from 'jose';
import type { PasswordHasher, TokenIssuer } from '../application/ports.js';

/** scrypt key derivation: Node's native one on the server, a JavaScript one in the browser. Same output. */
export type ScryptFn = (password: string, salt: Uint8Array, keylen: number, opts: { N: number; r: number; p: number }) => Promise<Uint8Array>;

/** scrypt with a per-password salt; format `scrypt$N$r$p$salt$hash`. No native modules required. */
export class ScryptHasher implements PasswordHasher {
  constructor(private readonly scrypt: ScryptFn) {}

  async hash(password: string): Promise<string> {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const N = 16384, r = 8, p = 1;
    const key = await this.scrypt(password, salt, 32, { N, r, p });
    return ['scrypt', N, r, p, toBase64Url(salt), toBase64Url(key)].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [alg, N, r, p, salt, hash] = stored.split('$');
    if (alg !== 'scrypt' || !N || !r || !p || !salt || !hash) return false;
    const expected = fromBase64Url(hash);
    const actual = await this.scrypt(password, fromBase64Url(salt), expected.length || 32, { N: +N, r: +r, p: +p });
    return constantTimeEqual(expected, actual);
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
      privateKey = await importPKCS8(pem, 'ES256', { extractable: true });
      // The public half of the configured key: its JWK without the private scalar.
      const { d: _private, ...pub } = await exportJWK(privateKey);
      publicJwk = pub;
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
