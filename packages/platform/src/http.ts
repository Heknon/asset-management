import { AppError, effectivePermissions, permissionMeta, type AccessScope, type ErrorBody, type Permission, type Principal } from '@am/core';
import type { FastifyRequest } from 'fastify';
// Route handlers use cookies (req.cookies, reply.setCookie) in every runtime.
import type {} from '@fastify/cookie';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { extractToken, type TokenVerifier } from './auth.js';

/**
 * HTTP request policy shared by every runtime: the Fastify server
 * (`@am/platform/node`) and the in-browser router (`@am/browser-runtime`).
 * Route handlers are written against Fastify's request/reply types.
 */

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

/**
 * CSRF defence in depth (cookies are SameSite too): browsers cannot set custom
 * headers cross-origin without a preflight, which this API never approves.
 * Then resolves the caller from the bearer token or session cookie; an invalid
 * token is anonymous (protected routes reject it via requirePrincipal()).
 */
export async function authenticate(method: string, headers: Record<string, unknown>, cookies: Record<string, string | undefined>, verifier: TokenVerifier): Promise<Principal | null> {
  const unsafe = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  const bearer = typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ');
  if (unsafe && !bearer && headers['x-requested-with'] !== 'asset-management') throw AppError.forbidden('Missing X-Requested-With header');
  const token = extractToken(headers, cookies);
  if (!token) return null;
  try {
    return await verifier.verify(token);
  } catch {
    return null;
  }
}

export function toErrorBody(err: unknown): ErrorBody {
  if (err instanceof AppError) return { error: { code: err.code, message: err.message, details: err.details } };
  if (err instanceof ZodError) return { error: { code: 'validation', message: 'Invalid request', details: { issues: err.issues } } };
  const e = err as { validation?: unknown; message?: string; statusCode?: number };
  if (e.validation || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)) return { error: { code: 'validation', message: e.message ?? 'Invalid request' } };
  return { error: { code: 'unavailable', message: e.message ?? 'Error' } };
}

/** The status and body for a failed request; internal errors never leak their message. */
export function errorResponse(err: unknown): { status: number; body: ErrorBody } {
  const body = toErrorBody(err);
  const status = err instanceof AppError ? err.status : body.error.code === 'validation' ? 400 : ((err as { statusCode?: number }).statusCode ?? 500);
  return { status, body: status >= 500 ? { error: { code: 'unavailable', message: 'Internal error' } } : body };
}

export const notFoundBody: ErrorBody = { error: { code: 'not_found', message: 'Route not found' } };

/** Parses input with a zod schema, turning failures into a 400 with field paths. */
export function parse<Out, In = Out>(schema: ZodType<Out, ZodTypeDef, In>, value: unknown): Out {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw AppError.validation('Invalid request', {
    issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw AppError.unauthenticated();
  return req.principal;
}

export function requireAdmin(req: FastifyRequest): Principal {
  const p = requirePrincipal(req);
  if (!p.isAdmin) throw AppError.forbidden('Administrator access required');
  return p;
}

/**
 * Throws unless the principal has `required` on the scope; returns everything
 * they may do there. Without even "see", the resource does not exist for them.
 */
export function authorize(principal: Principal, required: Permission, scope: AccessScope): Set<Permission> {
  const perms = effectivePermissions(principal, scope);
  if (!perms.has('view')) throw AppError.notFound('Resource');
  if (!perms.has(required)) throw AppError.forbidden(`This needs the “${permissionMeta[required].label}” permission`);
  return perms;
}

/** A text body produced piece by piece (large exports), as a web stream every runtime can send. */
export function textStream(chunks: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const it = chunks[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await it.return?.();
    },
  });
}
