import {
  AppError,
  accessUpdateSchema,
  grantInputSchema,
  peopleResolveSchema,
  subjectSearchSchema,
  groupInputSchema,
  pageQuerySchema,
  passwordLoginSchema,
  preferencesSchema,
  orgImportSchema,
  orgUnitInputSchema,
  unitPeopleSchema,
  localUserCreateSchema,
  passwordChangeSchema,
  passwordSetSchema,
  userUpdateSchema,
} from '@am/core';
import { ACCESS_COOKIE, parse, REFRESH_COOKIE, requireAdmin, requirePrincipal } from '@am/platform';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthService, IssuedSession } from '../application/auth-service.js';
import type { AccessService } from '../application/access-service.js';
import type { DirectoryService } from '../application/directory-service.js';
import type { OrgService } from '../application/org-service.js';
import type { RedirectState } from '../application/ports.js';
import type { GoogleSignIn } from '../application/google-sign-in.js';
import { registerGoogleRoutes } from './google-routes.js';

const OIDC_STATE_COOKIE = 'am_oidc';
const PREFIX = '/api/identity';
const idParam = z.object({ id: z.string().uuid() });

export interface RouteOptions {
  auth: AuthService;
  directory: DirectoryService;
  org: OrgService;
  access: AccessService;
  jwks: () => Promise<unknown>;
  publicUrl: string;
  secureCookies: boolean;
  accessTtlSeconds: number;
  google: GoogleSignIn | null;
}

/** Only same-site relative paths, so the login flow cannot be used as an open redirect. */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/';
}

/** Small fixed-window limiter against password guessing; per replica. */
function loginLimiter(max = 10, windowMs = 5 * 60_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string) => {
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || cur.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return;
    }
    if (++cur.n > max) throw new AppError('forbidden', 'Too many sign-in attempts. Try again in a few minutes.');
  };
}

export function registerRoutes(app: FastifyInstance, o: RouteOptions): void {
  const limit = loginLimiter();

  const setSessionCookies = (reply: FastifyReply, s: IssuedSession) => {
    reply.setCookie(ACCESS_COOKIE, s.accessToken, { path: '/', httpOnly: true, secure: o.secureCookies, sameSite: 'lax', maxAge: o.accessTtlSeconds });
    reply.setCookie(REFRESH_COOKIE, s.refreshToken, { path: `${PREFIX}/auth`, httpOnly: true, secure: o.secureCookies, sameSite: 'strict', expires: s.refreshExpiresAt });
  };
  const clearSessionCookies = (reply: FastifyReply) => {
    reply.clearCookie(ACCESS_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_COOKIE, { path: `${PREFIX}/auth` });
  };

  if (o.google) {
    registerGoogleRoutes(app, {
      google: o.google,
      signIn: (email, userAgent) => o.auth.loginWithVerifiedEmail(email, userAgent),
      setSessionCookies,
      safeReturnTo,
      secureCookies: o.secureCookies,
    });
  }

  app.get(`${PREFIX}/.well-known/jwks.json`, async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return o.jwks();
  });

  // ─── Authentication ──────────────────────────────────────────────────────

  app.get(`${PREFIX}/auth/providers`, async () => o.auth.providers());

  app.post(`${PREFIX}/auth/login`, async (req, reply) => {
    const input = parse(passwordLoginSchema, req.body);
    limit(`${req.ip}|${input.username.toLowerCase()}`);
    const session = await o.auth.loginWithPassword(input, req.headers['user-agent'] ?? null);
    setSessionCookies(reply, session);
    return o.auth.me(session.user.id);
  });

  app.get(`${PREFIX}/auth/oidc/start`, async (req, reply) => {
    const returnTo = safeReturnTo((req.query as { returnTo?: string }).returnTo);
    const { url, state } = await o.auth.beginRedirect(`${o.publicUrl}${PREFIX}/auth/oidc/callback`);
    reply.setCookie(OIDC_STATE_COOKIE, JSON.stringify({ ...state, returnTo }), {
      path: `${PREFIX}/auth/oidc`,
      httpOnly: true,
      secure: o.secureCookies,
      sameSite: 'lax',
      signed: true,
      maxAge: 600,
    });
    return reply.redirect(url);
  });

  app.get(`${PREFIX}/auth/oidc/callback`, async (req, reply) => {
    const raw = req.cookies[OIDC_STATE_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(OIDC_STATE_COOKIE, { path: `${PREFIX}/auth/oidc` });
    if (!unsigned?.valid || !unsigned.value) return reply.redirect(`/login?error=${encodeURIComponent('Sign-in expired, please try again')}`);
    const state = JSON.parse(unsigned.value) as RedirectState & { returnTo: string };
    try {
      const callback = new URL(`${o.publicUrl}${req.url}`);
      const session = await o.auth.completeRedirect(callback, state, req.headers['user-agent'] ?? null);
      setSessionCookies(reply, session);
      return reply.redirect(safeReturnTo(state.returnTo));
    } catch (err) {
      req.log.warn({ err: { message: (err as Error).message } }, 'OIDC sign-in failed');
      return reply.redirect(`/login?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  app.post(`${PREFIX}/auth/refresh`, async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw AppError.unauthenticated();
    try {
      const session = await o.auth.refresh(token);
      setSessionCookies(reply, session);
      return { ok: true };
    } catch (err) {
      clearSessionCookies(reply);
      throw err;
    }
  });

  app.post(`${PREFIX}/auth/logout`, async (req, reply) => {
    await o.auth.logout(req.cookies[REFRESH_COOKIE]);
    clearSessionCookies(reply);
    return { ok: true };
  });

  // ─── Self service ────────────────────────────────────────────────────────

  app.get(`${PREFIX}/me`, async (req) => o.auth.me(requirePrincipal(req).userId));

  // Where the person is signed in (browsers and connected apps such as MCP clients), and signing one out.
  app.get(`${PREFIX}/me/sessions`, async (req) => o.auth.sessions(requirePrincipal(req).userId));
  app.delete(`${PREFIX}/me/sessions/:id`, async (req, reply) => {
    await o.auth.endSession(requirePrincipal(req).userId, parse(idParam, req.params).id);
    return reply.status(204).send();
  });

  app.patch(`${PREFIX}/me/preferences`, async (req) => o.directory.updatePreferences(requirePrincipal(req).userId, parse(preferencesSchema, req.body)));

  app.get(`${PREFIX}/people`, async (req) => {
    requirePrincipal(req);
    const q = parse(z.object({ q: z.string().max(100).optional(), ids: z.string().optional() }), req.query);
    const ids = q.ids?.split(',').filter((id) => z.string().uuid().safeParse(id).success);
    return o.directory.userSummaries(q.q, ids);
  });

  /** Import: match cells ("dana@corp.com", "dcohen", "Dana Cohen") to people; ambiguous names stay unmatched. */
  app.post(`${PREFIX}/people/resolve`, async (req) => {
    requirePrincipal(req);
    return o.directory.resolvePeople(parse(peopleResolveSchema, req.body).values);
  });

  // The org chart is visible to everyone signed in (names only; access is enforced per asset).
  app.get(`${PREFIX}/units`, async (req) => {
    const p = requirePrincipal(req);
    const { archived } = parse(z.object({ archived: z.enum(['true', 'false']).default('false') }), req.query);
    return o.org.list(archived === 'true' && p.isAdmin);
  });
  app.get(`${PREFIX}/units/:id`, async (req) => {
    requirePrincipal(req);
    return o.org.get(parse(idParam, req.params).id);
  });
  app.get(`${PREFIX}/units/:id/people`, async (req) => {
    requirePrincipal(req);
    return o.org.people(parse(idParam, req.params).id);
  });
  app.put(`${PREFIX}/units/:id/people`, async (req) => {
    const p = parse(unitPeopleSchema, req.body);
    return o.org.setPeople(requirePrincipal(req), parse(idParam, req.params).id, p.members, p.managers);
  });

  // ─── Administration ──────────────────────────────────────────────────────

  app.get(`${PREFIX}/users`, async (req) => {
    requireAdmin(req);
    const q = parse(pageQuerySchema.extend({ q: z.string().max(100).optional() }), req.query);
    return o.directory.listUsers(q);
  });

  app.post(`${PREFIX}/users`, async (req) => {
    requireAdmin(req);
    return o.directory.createLocalUser(parse(localUserCreateSchema, req.body));
  });
  app.put(`${PREFIX}/users/:id/password`, async (req, reply) => {
    requireAdmin(req);
    await o.directory.setPassword(parse(idParam, req.params).id, parse(passwordSetSchema, req.body).password);
    return reply.status(204).send();
  });
  app.post(`${PREFIX}/me/password`, async (req, reply) => {
    const input = parse(passwordChangeSchema, req.body);
    await o.directory.changeOwnPassword(requirePrincipal(req).userId, input.current, input.password);
    return reply.status(204).send();
  });
  app.patch(`${PREFIX}/users/:id`, async (req) => {
    const actor = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    return o.directory.updateUser(actor.userId, id, parse(userUpdateSchema, req.body));
  });

  app.get(`${PREFIX}/groups`, async (req) => {
    requireAdmin(req);
    return o.directory.listGroups();
  });
  app.post(`${PREFIX}/groups`, async (req) => {
    requireAdmin(req);
    return o.directory.createGroup(parse(groupInputSchema, req.body));
  });
  app.put(`${PREFIX}/groups/:id`, async (req) => {
    requireAdmin(req);
    return o.directory.updateGroup(parse(idParam, req.params).id, parse(groupInputSchema, req.body));
  });
  app.delete(`${PREFIX}/groups/:id`, async (req, reply) => {
    requireAdmin(req);
    await o.directory.deleteGroup(parse(idParam, req.params).id);
    return reply.status(204).send();
  });
  app.get(`${PREFIX}/groups/:id/members`, async (req) => {
    requireAdmin(req);
    return o.directory.listGroupMembers(parse(idParam, req.params).id);
  });
  app.put(`${PREFIX}/groups/:id/members`, async (req, reply) => {
    requireAdmin(req);
    const { userIds } = parse(z.object({ userIds: z.array(z.string().uuid()).max(5000) }), req.body);
    await o.directory.setGroupMembers(parse(idParam, req.params).id, userIds);
    return reply.status(204).send();
  });

  app.post(`${PREFIX}/units`, async (req) => {
    requireAdmin(req);
    return o.org.create(parse(orgUnitInputSchema, req.body));
  });
  app.put(`${PREFIX}/units/:id`, async (req) => {
    requireAdmin(req);
    return o.org.update(parse(idParam, req.params).id, parse(orgUnitInputSchema, req.body));
  });
  app.post(`${PREFIX}/units/republish`, async (req) => {
    requireAdmin(req);
    return { units: await o.org.republishAll() };
  });
  app.post(`${PREFIX}/units/import`, async (req) => {
    requireAdmin(req);
    return o.org.import(parse(orgImportSchema, req.body));
  });

  // ─── Access (roles on units and the whole organization) ──────────────────

  app.get(`${PREFIX}/subjects`, async (req) => {
    requirePrincipal(req);
    const q = parse(subjectSearchSchema, req.query);
    return o.access.searchSubjects(q.q, q.kinds);
  });
  app.get(`${PREFIX}/units/:id/access`, async (req) => o.access.unitAccess(requirePrincipal(req), parse(idParam, req.params).id));
  app.get(`${PREFIX}/access`, async (req) => o.access.organizationAccess(requirePrincipal(req)));
  app.post(`${PREFIX}/grants`, async (req, reply) => reply.status(201).send(await o.access.grant(requirePrincipal(req), parse(grantInputSchema, req.body))));
  app.patch(`${PREFIX}/grants/:id`, async (req) => o.access.update(requirePrincipal(req), parse(idParam, req.params).id, parse(accessUpdateSchema, req.body).access));
  app.delete(`${PREFIX}/grants/:id`, async (req, reply) => {
    await o.access.revoke(requirePrincipal(req), parse(idParam, req.params).id);
    return reply.status(204).send();
  });
}
