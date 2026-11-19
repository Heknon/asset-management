import { AppError, type Grant, type GrantLevel, type Principal } from '@am/core';
import { createRemoteJWKSet, jwtVerify, type CryptoKey, type JWTPayload, type JWTVerifyGetKey, type KeyObject } from 'jose';

export const ACCESS_COOKIE = 'am_access';
export const REFRESH_COOKIE = 'am_refresh';

/** Compact grant encoding keeps tokens small: [purchaseClassId|0, assetTypeId|0, level]. */
type CompactGrant = [string | 0, string | 0, GrantLevel];

export interface AccessClaims extends JWTPayload {
  sub: string;
  usr: string;
  name: string;
  email: string | null;
  adm: boolean;
  grt: CompactGrant[];
}

export function principalToClaims(p: Principal): Omit<AccessClaims, 'iat' | 'exp' | 'iss' | 'aud'> {
  return {
    sub: p.userId,
    usr: p.username,
    name: p.displayName,
    email: p.email,
    adm: p.isAdmin,
    grt: p.grants.map((g) => [g.purchaseClassId ?? 0, g.assetTypeId ?? 0, g.level]),
  };
}

export function claimsToPrincipal(c: AccessClaims): Principal {
  return {
    userId: c.sub,
    username: c.usr,
    displayName: c.name,
    email: c.email,
    isAdmin: c.adm === true,
    grants: (c.grt ?? []).map(([pc, at, level]): Grant => ({ purchaseClassId: pc || null, assetTypeId: at || null, level })),
  };
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

export function createTokenVerifier(key: JWTVerifyGetKey | CryptoKey | KeyObject, opts: { issuer: string; audience: string }): TokenVerifier {
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, { issuer: opts.issuer, audience: opts.audience, algorithms: ['ES256'] });
        return claimsToPrincipal(payload as AccessClaims);
      } catch {
        throw AppError.unauthenticated('Invalid or expired session');
      }
    },
  };
}

export function createJwksVerifier(jwksUrl: string, opts: { issuer: string; audience: string }): TokenVerifier {
  return createTokenVerifier(createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000 }), opts);
}

/** Bearer header (API clients) or the session cookie (browser). */
export function extractToken(headers: Record<string, unknown>, cookies: Record<string, string | undefined>): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return cookies[ACCESS_COOKIE] ?? null;
}
