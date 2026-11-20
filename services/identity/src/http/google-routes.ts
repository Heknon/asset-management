import { AppError } from '@am/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IssuedSession } from '../application/auth-service.js';
import { GOOGLE_CALLBACK_PATH, GOOGLE_SIGNIN_PATH, type GoogleCookie, type GoogleSignIn } from '../application/google-sign-in.js';

const COOKIE = 'am_google';
const COOKIE_PATH = '/api/auth';

export interface GoogleRouteOptions {
  google: GoogleSignIn;
  signIn(email: string, userAgent: string | null): Promise<IssuedSession>;
  setSessionCookies(reply: FastifyReply, session: IssuedSession): void;
  safeReturnTo(value: unknown): string;
  secureCookies: boolean;
}

/** The origin the browser used, as the platform's proxy reports it; checked against the allow-list before use. */
function requestOrigin(req: FastifyRequest): string | undefined {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  const host = first(req.headers['x-forwarded-host']) ?? first(req.headers.host);
  if (!host) return undefined;
  const proto = first(req.headers['x-forwarded-proto']) === 'https' ? 'https' : 'http';
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return undefined;
  }
}

/** Google sign-in at the paths the kit's OAuth client expects (`/api/auth/...`). */
export function registerGoogleRoutes(app: FastifyInstance, o: GoogleRouteOptions): void {
  const fail = (message: string) => `/login?error=${encodeURIComponent(message)}`;

  app.get(GOOGLE_SIGNIN_PATH, async (req, reply) => {
    const returnTo = o.safeReturnTo((req.query as { returnTo?: string }).returnTo);
    const { url, cookie } = await o.google.begin(returnTo, requestOrigin(req));
    reply.setCookie(COOKIE, JSON.stringify(cookie), { path: COOKIE_PATH, httpOnly: true, secure: o.secureCookies, sameSite: 'lax', signed: true, maxAge: 600 });
    return reply.redirect(url);
  });

  app.get(GOOGLE_CALLBACK_PATH, async (req, reply) => {
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const raw = req.cookies[COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    let cookie: GoogleCookie | null = null;
    try {
      cookie = unsigned?.valid && unsigned.value ? (JSON.parse(unsigned.value) as GoogleCookie) : null;
    } catch {
      cookie = null;
    }
    try {
      const outcome = await o.google.callback(query, cookie, requestOrigin(req));
      if (outcome.kind === 'forward') return reply.redirect(outcome.location);
      reply.clearCookie(COOKIE, { path: COOKIE_PATH });
      const session = await o.signIn(outcome.email, req.headers['user-agent'] ?? null);
      o.setSessionCookies(reply, session);
      return reply.redirect(o.safeReturnTo(outcome.returnTo));
    } catch (err) {
      reply.clearCookie(COOKIE, { path: COOKIE_PATH });
      req.log.warn({ err: { message: (err as Error).message, reason: err instanceof AppError ? err.details?.reason : undefined } }, 'Google sign-in failed');
      return reply.redirect(fail(err instanceof AppError ? err.message : 'Google sign-in failed, please try again'));
    }
  });
}
