import type { Asset, Me, Page, PurchaseRequest } from '@am/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiCallError, type ApiClient } from './api-client.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback).describe(`How many to return (1–${max}, default ${fallback})`);
const offset = z.number().int().min(0).default(0).describe('How many to skip, for the next page');

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

interface ToolConfig<S extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema?: S;
  annotations: ToolAnnotations;
}

/**
 * registerTool with our own argument typing: the SDK's generic signature makes
 * the compiler expand every zod type of every tool (minutes per typecheck).
 */
function tool<S extends z.ZodRawShape>(server: McpServer, name: string, config: ToolConfig<S>, handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>): void {
  (server.registerTool as unknown as (n: string, c: unknown, h: (args: unknown) => Promise<CallToolResult>) => void).call(server, name, config, (args) => handler(args as z.infer<z.ZodObject<S>>));
}

/** Tool results are JSON for the model, with links into the app it can show the person. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof ApiCallError ? (err.status === 403 ? `Not allowed: ${err.message}` : err.status === 404 ? `Not found: ${err.message}` : err.message) : (err as Error).message;
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

/** Every tool acts as the signed-in person, through the same APIs the app uses. */
export function registerTools(server: McpServer, api: ApiClient, appUrl: string): void {
  const link = (path: string) => `${appUrl}${path}`;

  tool(
    server,
    'whoami',
    { title: 'Who am I', description: 'The person this connection acts as: name, email, whether they are an administrator, and the organization units they belong to or manage.', annotations: readOnly },
    () =>
      run(async () => {
        const me = await api.get<Me>('identity', '/api/identity/me');
        return { id: me.userId, username: me.username, displayName: me.displayName, email: me.email, isAdmin: me.isAdmin, units: me.units };
      }),
  );

  tool(
    server,
    'search',
    {
      title: 'Search',
      description: 'Full-text search across everything the person can see: assets (licenses, contracts, certificates, equipment…), requests, templates and organization units. Start here when the user names something.',
      inputSchema: { query: z.string().min(1).max(200).describe('Words to look for, e.g. "Adobe" or "LIC-42"'), limit: limit(50, 10) },
      annotations: readOnly,
    },
    ({ query, limit }) => run(() => api.get('registry', '/api/registry/search', { q: query, limit })),
  );

  tool(
    server,
    'list_asset_types',
    { title: 'List asset types', description: 'The kinds of assets this organization tracks (templates), with their fields. Use the ids to filter list_assets.', annotations: readOnly },
    () => run(() => api.get('registry', '/api/registry/asset-types')),
  );

  tool(
    server,
    'list_units',
    { title: 'List organization units', description: 'The organization tree (departments, teams…) with ids, for filtering and for creating requests.', annotations: readOnly },
    () => run(() => api.get('identity', '/api/identity/units')),
  );

  tool(
    server,
    'list_assets',
    {
      title: 'List assets',
      description: 'Assets the person can see, newest changes first, optionally filtered by type, unit, status, owner or words.',
      inputSchema: {
        query: z.string().max(200).optional().describe('Words to match in names and values'),
        assetTypeId: uuid.optional().describe('Only this asset type (see list_asset_types)'),
        unitId: uuid.optional().describe('Only this unit and the units beneath it (see list_units)'),
        status: z.string().max(60).optional().describe('Only this status key, e.g. "active"'),
        ownerId: uuid.optional().describe('Only assets this person owns'),
        limit: limit(100, 25),
        offset,
      },
      annotations: readOnly,
    },
    ({ query, ...rest }) =>
      run(async () => {
        const page = await api.get<Page<Asset>>('registry', '/api/registry/assets', { q: query, ...rest });
        return { ...page, items: page.items.map((a) => ({ ...a, url: link(`/assets/${a.id}`) })) };
      }),
  );

  tool(
    server,
    'get_asset',
    { title: 'Get an asset', description: 'One asset with all its field values, dates, owner and contacts.', inputSchema: { id: uuid.describe('The asset id (from search or list_assets)') }, annotations: readOnly },
    ({ id }) => run(async () => ({ ...(await api.get<Asset>('registry', `/api/registry/assets/${id}`)), url: link(`/assets/${id}`) })),
  );

  tool(
    server,
    'upcoming',
    {
      title: 'Upcoming dates',
      description: 'Renewals, expiries and other dates coming up (or overdue) on assets the person can see, soonest first.',
      inputSchema: {
        from: isoDate.optional().describe('From this day (YYYY-MM-DD)'),
        to: isoDate.optional().describe('Up to this day (YYYY-MM-DD)'),
        mine: z.boolean().default(false).describe('Only items the person owns or is a contact for'),
        unitId: uuid.optional().describe('Only this unit and beneath'),
        state: z.enum(['active', 'open', 'snoozed', 'done', 'dismissed', 'all']).default('active'),
        limit: limit(200, 50),
        offset,
      },
      annotations: readOnly,
    },
    (args) => run(() => api.get('scheduler', '/api/scheduler/obligations', args)),
  );

  tool(
    server,
    'list_requests',
    {
      title: 'List requests',
      description: 'Purchase and renewal requests. Scope: mine (I asked), team (my units), handle (I can process), all (everything I can see).',
      inputSchema: {
        scope: z.enum(['mine', 'team', 'handle', 'all']).default('mine'),
        status: z.string().max(60).default('open').describe('open, closed, all, or one status key'),
        kind: z.enum(['purchase', 'renewal']).optional(),
        query: z.string().max(200).optional(),
        limit: limit(100, 25),
        offset,
      },
      annotations: readOnly,
    },
    ({ query, ...rest }) =>
      run(async () => {
        const page = await api.get<Page<PurchaseRequest>>('registry', '/api/registry/requests', { q: query, ...rest });
        return { ...page, items: page.items.map((r) => ({ ...r, url: link(`/requests/${r.id}`) })) };
      }),
  );

  tool(
    server,
    'get_request',
    { title: 'Get a request', description: 'One request with its status, details and what can be done next.', inputSchema: { id: uuid }, annotations: readOnly },
    ({ id }) => run(async () => ({ ...(await api.get<PurchaseRequest>('registry', `/api/registry/requests/${id}`)), url: link(`/requests/${id}`) })),
  );

  tool(
    server,
    'create_request',
    {
      title: 'Create a request',
      description: 'Asks for something to be bought or arranged, on behalf of the person, in one of their units. Confirm the details with the user first.',
      inputSchema: {
        title: z.string().min(3).max(200),
        description: z.string().max(4000).default(''),
        unitId: uuid.describe('The unit the request is for (see whoami / list_units)'),
        assetTypeId: uuid.optional().describe('What kind of asset it is for, if known'),
        quantity: z.number().int().positive().max(1_000_000).optional(),
        estimatedCost: z.object({ amount: z.number().min(0), currency: z.string().length(3).describe('ISO code, e.g. USD') }).optional(),
        neededBy: isoDate.optional(),
        link: z.string().url().max(2000).optional().describe('A quote, product page or ticket'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const created = await api.post<PurchaseRequest>('registry', '/api/registry/requests', {
          ...args,
          assetTypeId: args.assetTypeId ?? null,
          quantity: args.quantity ?? null,
          estimatedCost: args.estimatedCost ?? null,
          neededBy: args.neededBy ?? null,
          link: args.link ?? null,
        });
        return { ...created, url: link(`/requests/${created.id}`) };
      }),
  );

  tool(
    server,
    'comment_on_asset',
    {
      title: 'Comment on an asset',
      description: "Adds a comment to an asset's conversation, as the person. Confirm the text with the user first.",
      inputSchema: { assetId: uuid, body: z.string().min(1).max(5000) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ assetId, body }) => run(() => api.post('registry', `/api/registry/assets/${assetId}/comments`, { body, mentionIds: [] })),
  );
}
