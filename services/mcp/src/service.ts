import { defineService, outboxMigration, type OutboxTable } from '@am/platform';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { ApiClient } from './api-client.js';
import { registerTools } from './tools.js';

export const mcpConfig = {
  /** Where the other services answer; in one process (serverless) they are reached in-process instead. */
  IDENTITY_URL: z.string().url().default('http://identity:8080'),
  REGISTRY_URL: z.string().url().default('http://registry:8080'),
  SCHEDULER_URL: z.string().url().default('http://scheduler:8080'),
};

export interface McpAdapters {
  /** Reaches the other services: the network on the server, in-process when serverless. */
  fetcher?: typeof fetch;
}

/** Called by MCP clients with their own token: cookies are ignored and no CSRF header is needed. */
const publicApi = { config: { publicApi: true } };
const VERSION = '0.1.0';

/**
 * The Model Context Protocol server: lets AI assistants (Claude, IDEs, any MCP
 * client) find and work with assets as the person who connected them. Clients
 * discover the sign-in here (RFC 9728), the person accepts on the app's
 * /oauth/authorize page, and every tool call runs with that person's access.
 * Stateless Streamable HTTP, so any replica answers any request.
 */
export const defineMcpService = (adapters: McpAdapters = {}) =>
  defineService<OutboxTable, typeof mcpConfig>({
    name: 'mcp',
    config: mcpConfig,
    migrations: { '0001_outbox': outboxMigration },
    async register({ config, app, logger }) {
      const publicUrl = config.PUBLIC_URL.replace(/\/$/, '');
      const resource = `${publicUrl}/mcp`;
      const metadataUrl = `${publicUrl}/.well-known/oauth-protected-resource/mcp`;
      const urls = { identity: config.IDENTITY_URL, registry: config.REGISTRY_URL, scheduler: config.SCHEDULER_URL };
      const fetcher = adapters.fetcher ?? ((input, init) => fetch(input, init));

      const cors = (reply: FastifyReply) =>
        reply
          .header('access-control-allow-origin', '*')
          .header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
          .header('access-control-allow-headers', 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id')
          .header('access-control-expose-headers', 'www-authenticate, mcp-session-id, mcp-protocol-version');

      // RFC 9728: which authorization server signs people in for this resource.
      const metadata = {
        resource,
        authorization_servers: [publicUrl],
        bearer_methods_supported: ['header'],
        scopes_supported: ['assets'],
        resource_name: 'Assets',
        resource_documentation: `${publicUrl}/`,
      };
      for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/mcp/.well-known/oauth-protected-resource']) {
        app.get(path, async (_req, reply) => {
          cors(reply).header('cache-control', 'public, max-age=300');
          return metadata;
        });
      }

      /** The caller's token, if it is valid and was issued for this MCP server (not just any app session). */
      const tokenFor = (req: FastifyRequest): string | null => {
        const auth = req.headers.authorization;
        if (!req.principal || typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
        const token = auth.slice(7);
        const aud = decodeJwt(token).aud;
        return (Array.isArray(aud) ? aud : [aud]).includes(resource) ? token : null;
      };

      const unauthorized = (reply: FastifyReply, error = 'invalid_token') =>
        cors(reply)
          .status(401)
          .header('www-authenticate', `Bearer error="${error}", resource_metadata="${metadataUrl}", scope="assets"`)
          .send({ jsonrpc: '2.0', error: { code: -32001, message: 'Sign in to Assets: connect this client to get a token' }, id: null });

      app.options('/mcp', async (_req, reply) => cors(reply).status(204).send());

      app.post('/mcp', publicApi, async (req, reply) => {
        const token = tokenFor(req);
        if (!token) return unauthorized(reply);

        // A fresh server per request: no sessions to keep, so any replica (or function instance) can answer.
        const server = new McpServer(
          { name: 'assets', title: 'Assets', version: VERSION },
          {
            capabilities: { tools: {} },
            instructions:
              'Assets tracks licenses, contracts, certificates, equipment and their renewal dates, plus purchase and renewal requests. Use search to find things by name, upcoming for what is due, and list_requests for requests. Everything runs with the signed-in person’s own access. Ask before creating or commenting.',
          },
        );
        registerTools(server, new ApiClient(urls, token, fetcher), publicUrl);
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        try {
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const response = await transport.handleRequest(new Request(`${publicUrl}${req.url}`, { method: 'POST', headers }), {
            parsedBody: req.body,
            authInfo: { token, clientId: 'mcp', scopes: ['assets'], resource: new URL(resource) },
          });
          cors(reply).status(response.status);
          response.headers.forEach((value, key) => {
            if (key !== 'content-length') reply.header(key, value);
          });
          return reply.send(response.status === 202 ? '' : await response.text());
        } catch (err) {
          logger.error({ err }, 'MCP request failed');
          throw err;
        } finally {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        }
      });

      // Stateless: no server-initiated stream and no session to end.
      for (const method of ['get', 'delete'] as const) {
        app[method]('/mcp', publicApi, async (req, reply) => {
          if (!tokenFor(req)) return unauthorized(reply);
          return cors(reply).status(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST' }, id: null });
        });
      }

      logger.info({ resource }, 'MCP server ready');
    },
  });
