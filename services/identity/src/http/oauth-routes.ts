import { AppError } from '@am/core';
import { requirePrincipal } from '@am/platform';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthorizeParams, OAuthService } from '../application/oauth-service.js';

const PREFIX = '/api/identity/oauth';
/** Called by MCP clients (other programs), not the app: no cookies, no CSRF header, form bodies. */
const publicApi = { config: { publicApi: true } };

const authorizeParams = z
  .object({
    response_type: z.string().optional(),
    client_id: z.string().max(200).optional(),
    redirect_uri: z.string().max(2000).optional(),
    code_challenge: z.string().max(200).optional(),
    code_challenge_method: z.string().max(20).optional(),
    state: z.string().max(2000).optional(),
    scope: z.string().max(500).optional(),
    resource: z.string().max(2000).optional(),
  })
  .passthrough();

const cors = (reply: FastifyReply) =>
  reply.header('access-control-allow-origin', '*').header('access-control-allow-methods', 'GET, POST, OPTIONS').header('access-control-allow-headers', 'content-type, authorization, mcp-protocol-version');

/** OAuth errors are `{ error, error_description }` (RFC 6749 §5.2), not the API's error body. */
async function oauthResponse(reply: FastifyReply, run: () => Promise<unknown>) {
  cors(reply).header('cache-control', 'no-store');
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const code = typeof err.details?.oauth === 'string' ? err.details.oauth : err.code === 'unauthenticated' ? 'invalid_client' : 'invalid_request';
    return reply.status(code === 'invalid_client' ? 401 : 400).send({ error: code, error_description: err.message });
  }
}

export function registerOAuthRoutes(app: FastifyInstance, oauth: OAuthService): void {
  // RFC 8414 metadata, at the origin root (MCP clients look there) and under the service's own prefix.
  for (const path of ['/.well-known/oauth-authorization-server', '/api/identity/.well-known/oauth-authorization-server']) {
    app.get(path, async (_req, reply) => {
      cors(reply).header('cache-control', 'public, max-age=300');
      return oauth.metadata();
    });
  }

  for (const path of ['register', 'token', 'revoke']) app.options(`${PREFIX}/${path}`, async (_req, reply) => cors(reply).status(204).send());

  app.post(`${PREFIX}/register`, publicApi, async (req, reply) => oauthResponse(reply, async () => reply.status(201).send(await oauth.register((req.body ?? {}) as Record<string, unknown>))));

  app.post(`${PREFIX}/token`, publicApi, async (req, reply) =>
    oauthResponse(reply, () => oauth.token(Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : undefined])))),
  );

  app.post(`${PREFIX}/revoke`, publicApi, async (req, reply) =>
    oauthResponse(reply, async () => {
      await oauth.revoke(((req.body ?? {}) as { token?: string }).token);
      return {};
    }),
  );

  // ─── The accept screen (the app's /oauth/authorize page, signed in) ─────
  app.get(`${PREFIX}/request`, async (req) => {
    requirePrincipal(req);
    return oauth.describe(authorizeParams.parse(req.query) as AuthorizeParams);
  });

  app.post(`${PREFIX}/decision`, async (req) => {
    const principal = requirePrincipal(req);
    const body = z.object({ params: authorizeParams, accept: z.boolean() }).parse(req.body);
    return oauth.decide(principal.userId, body.params as AuthorizeParams, body.accept);
  });
}
