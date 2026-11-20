import { AppError, fromMask, permissionsOfLevel, toMask, type Grant, type Principal, type UnitRole } from '@am/core';
import { createRemoteJWKSet, jwtVerify, type CryptoKey, type JWTPayload, type JWTVerifyGetKey, type KeyObject } from 'jose';

export const ACCESS_COOKIE = 'am_access';
export const REFRESH_COOKIE = 'am_refresh';

/** Compact encodings keep tokens small: grants [unitId|0, assetTypeId|0, permission bitmask], units [unitId, 'm'|'g']. */
type CompactGrant = [string | 0, string | 0, number | string];
type CompactUnit = [string, 'm' | 'g'];

export interface AccessClaims extends JWTPayload {
  sub: string;
  usr: string;
  name: string;
  email: string | null;
  adm: boolean;
  grt: CompactGrant[];
  unt: CompactUnit[];
}

export function principalToClaims(p: Principal): Omit<AccessClaims, 'iat' | 'exp' | 'iss' | 'aud'> {
  return {
    sub: p.userId,
    usr: p.username,
    name: p.displayName,
    email: p.email,
    adm: p.isAdmin,
    grt: p.grants.map((g) => [g.unitId ?? 0, g.assetTypeId ?? 0, toMask(g.permissions)]),
    unt: p.units.map((u) => [u.unitId, u.role === 'manager' ? 'g' : 'm']),
  };
}

export function claimsToPrincipal(c: AccessClaims): Principal {
  return {
    userId: c.sub,
    username: c.usr,
    displayName: c.name,
    email: c.email,
    isAdmin: c.adm === true,
    // Tokens issued before roles carried 'view' | 'edit' | 'manage'; they expire within minutes.
    grants: (c.grt ?? []).map(([unit, at, p]): Grant => ({ unitId: unit || null, assetTypeId: at || null, permissions: typeof p === 'number' ? fromMask(p) : permissionsOfLevel(p) })),
    units: (c.unt ?? []).map(([unitId, r]) => ({ unitId, role: (r === 'g' ? 'manager' : 'member') as UnitRole })),
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

/** base64url without padding, as used in tokens and stored hashes. */
export const toBase64Url = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** An unguessable token (sessions, calendar feeds), base64url, from the platform CSPRNG. */
export function randomToken(bytes = 32): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 of a string as lowercase hex (how session tokens are stored). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares secrets in time independent of where they differ. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
