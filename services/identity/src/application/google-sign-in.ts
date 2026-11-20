import { AppError } from '@am/core';
import { constantTimeEqual, fromBase64Url, randomToken, toBase64Url } from '@am/platform';

export const GOOGLE_CALLBACK_PATH = '/api/auth/callback/google';
export const GOOGLE_SIGNIN_PATH = '/api/auth/signin/google';
const STATE_TTL_MS = 10 * 60_000;

/** What Google sends back in `state`: who started sign-in, and a nonce tying it to that browser's cookie. */
export interface GoogleState {
  origin: string;
  nonce: string;
  exp: number;
}

/** The OAuth client: an authorization URL, and the code exchanged for verified claims. */
export interface GoogleClient {
  authorizationUrl(p: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): Promise<string>;
  /** `callbackUrl` is the redirect URI the code was issued for, with Google's query. */
  exchange(callbackUrl: URL, checks: { state: string; nonce: string; codeVerifier: string }): Promise<{ email?: unknown; email_verified?: unknown }>;
}

const encoder = new TextEncoder();

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

/** `<payload>.<signature>`, both base64url; the signature is HMAC-SHA256 with AUTH_SECRET. */
export async function signState(state: GoogleState, secret: string): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(state)));
  return `${payload}.${toBase64Url(await hmac(secret, payload))}`;
}

/** The state if it was signed with `secret` and has not expired; otherwise null. */
export async function verifyState(value: string, secret: string, now = Date.now()): Promise<GoogleState | null> {
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  let given: Uint8Array;
  try {
    given = fromBase64Url(signature);
  } catch {
    return null;
  }
  if (!constantTimeEqual(given, await hmac(secret, payload))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Partial<GoogleState>;
    if (typeof s.origin !== 'string' || typeof s.nonce !== 'string' || typeof s.exp !== 'number' || s.exp < now) return null;
    return { origin: s.origin, nonce: s.nonce, exp: s.exp };
  } catch {
    return null;
  }
}

const originOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Where the proxy may send someone back: the deployment's own and configured
 * origins, previews on `*.vercel.app` ending with the team's suffix, and localhost.
 */
export function isAllowedReturnOrigin(origin: string, opts: { trusted: Array<string | undefined>; previewHostSuffix?: string }): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (opts.trusted.some((t) => originOf(t) === origin)) return true;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
  const suffix = opts.previewHostSuffix?.toLowerCase();
  return !!suffix && suffix.endsWith('.vercel.app') && url.protocol === 'https:' && !url.port && /^[a-z0-9-]+\.vercel\.app$/.test(url.hostname) && url.hostname.endsWith(suffix) && url.hostname.length > suffix.length;
}

export interface GoogleSignInOptions {
  client: GoogleClient;
  /** This deployment's origin (AUTH_URL, else the public URL). */
  origin: string;
  secret: string;
  /** AUTH_REDIRECT_PROXY_URL, e.g. `https://dev.example.com/api/auth`. */
  proxyUrl?: string;
  previewHostSuffix?: string;
}

/** What the browser keeps (in a signed cookie) between starting sign-in and the callback. */
export interface GoogleCookie {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

export type CallbackOutcome = { kind: 'forward'; location: string } | { kind: 'signed-in'; email: string; returnTo: string };

/**
 * Google sign-in with the contract's preview proxy: with a proxy URL, Google
 * returns to the proxy, which checks the signed state and forwards the query to
 * the origin that started; that origin exchanges the code with the proxy's
 * redirect URI.
 */
export class GoogleSignIn {
  readonly origin: string;
  private readonly proxyUrl: string | null;

  constructor(private readonly o: GoogleSignInOptions) {
    this.origin = new URL(o.origin).origin;
    this.proxyUrl = o.proxyUrl ? o.proxyUrl.replace(/\/+$/, '') : null;
  }

  /** The redirect URI Google is given and the code is exchanged with. */
  get redirectUri(): string {
    return this.proxyUrl ? `${this.proxyUrl}/callback/google` : `${this.origin}${GOOGLE_CALLBACK_PATH}`;
  }

  private get isProxy(): boolean {
    return !!this.proxyUrl && originOf(this.proxyUrl) === this.origin;
  }

  /**
   * The origin the browser is on, when sign-in goes through the proxy and it is
   * one this deployment may be reached at (a preview's deployment or branch URL);
   * otherwise the configured origin.
   */
  private here(requestOrigin?: string): string {
    if (this.proxyUrl && requestOrigin && isAllowedReturnOrigin(requestOrigin, { trusted: [this.origin], previewHostSuffix: this.o.previewHostSuffix })) return requestOrigin;
    return this.origin;
  }

  async begin(returnTo: string, requestOrigin?: string, now = Date.now()): Promise<{ url: string; cookie: GoogleCookie }> {
    const nonce = randomToken();
    const codeVerifier = randomToken();
    const state = await signState({ origin: this.here(requestOrigin), nonce, exp: now + STATE_TTL_MS }, this.o.secret);
    const challenge = toBase64Url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier))));
    const url = await this.o.client.authorizationUrl({ redirectUri: this.redirectUri, state, nonce, codeChallenge: challenge });
    return { url, cookie: { state, nonce, codeVerifier, returnTo } };
  }

  async callback(query: string, cookie: GoogleCookie | null, requestOrigin?: string, now = Date.now()): Promise<CallbackOutcome> {
    const params = new URLSearchParams(query);
    const raw = params.get('state');
    const state = raw ? await verifyState(raw, this.o.secret, now) : null;
    if (!state) throw AppError.unauthenticated('Sign-in expired, please try again');

    if (state.origin !== this.here(requestOrigin)) {
      if (!this.isProxy || !isAllowedReturnOrigin(state.origin, { trusted: [this.o.origin, this.proxyUrl ?? undefined], previewHostSuffix: this.o.previewHostSuffix })) {
        throw AppError.forbidden('Sign-in started on an address this deployment does not serve');
      }
      return { kind: 'forward', location: `${state.origin}${GOOGLE_CALLBACK_PATH}${query ? `?${query.replace(/^\?/, '')}` : ''}` };
    }

    if (params.get('error')) throw AppError.unauthenticated('Google sign-in was cancelled');
    if (!cookie || cookie.state !== raw || cookie.nonce !== state.nonce) throw AppError.unauthenticated('Sign-in expired, please try again');
    const callbackUrl = new URL(this.redirectUri);
    callbackUrl.search = params.toString();
    let claims;
    try {
      claims = await this.o.client.exchange(callbackUrl, { state: raw!, nonce: cookie.nonce, codeVerifier: cookie.codeVerifier });
    } catch (err) {
      throw new AppError('unauthenticated', 'Google sign-in failed, please try again', { reason: (err as Error).message });
    }
    if (typeof claims.email !== 'string' || claims.email_verified !== true) throw AppError.forbidden('Google did not confirm this email address');
    return { kind: 'signed-in', email: claims.email.toLowerCase(), returnTo: cookie.returnTo };
  }
}
