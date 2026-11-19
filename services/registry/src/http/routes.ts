import {
  assetCreateSchema,
  assetQuerySchema,
  assetTypeInputSchema,
  assetUpdateSchema,
  dateKindInputSchema,
  fieldKeySchema,
  requestActionSchema,
  requestCreateSchema,
  requestQuerySchema,
  requestUpdateSchema,
  savedViewInputSchema,
  searchQuerySchema,
} from '@am/core';
import { parse, requireAdmin, requirePrincipal } from '@am/platform';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssetService } from '../application/asset-service.js';
import type { CatalogService } from '../application/catalog-service.js';
import type { RequestService } from '../application/request-service.js';
import type { SearchService } from '../application/search-service.js';

const PREFIX = '/api/registry';
const idParam = z.object({ id: z.string().uuid() });

export function registerRoutes(app: FastifyInstance, catalog: CatalogService, assets: AssetService, requests: RequestService, search: SearchService): void {
  // ─── Date kinds ──────────────────────────────────────────────────────────
  app.get(`${PREFIX}/date-kinds`, async (req) => {
    requirePrincipal(req);
    return catalog.listDateKinds();
  });
  app.post(`${PREFIX}/date-kinds`, async (req) => {
    requireAdmin(req);
    return catalog.createDateKind(parse(dateKindInputSchema, req.body));
  });
  app.put(`${PREFIX}/date-kinds/:id`, async (req) => {
    requireAdmin(req);
    const body = parse(dateKindInputSchema.extend({ archived: z.boolean().default(false) }), req.body);
    return catalog.updateDateKind(parse(idParam, req.params).id, body);
  });

  // ─── Asset types (templates) ─────────────────────────────────────────────
  app.get(`${PREFIX}/asset-types`, async (req) => {
    requirePrincipal(req);
    const { archived } = parse(z.object({ archived: z.enum(['true', 'false']).default('false') }), req.query);
    return catalog.listTypes(archived === 'true');
  });
  app.get(`${PREFIX}/asset-types/:id`, async (req) => {
    requirePrincipal(req);
    return catalog.getType(parse(idParam, req.params).id);
  });
  app.post(`${PREFIX}/asset-types`, async (req) => {
    requireAdmin(req);
    return catalog.createType(parse(assetTypeInputSchema, req.body));
  });
  app.put(`${PREFIX}/asset-types/:id`, async (req) => {
    requireAdmin(req);
    const body = parse(assetTypeInputSchema.extend({ version: z.number().int().positive() }), req.body);
    const { version, ...input } = body;
    return catalog.updateType(parse(idParam, req.params).id, input, version);
  });
  app.post(`${PREFIX}/asset-types/:id/archive`, async (req) => {
    requireAdmin(req);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    return catalog.setArchived(parse(idParam, req.params).id, archived);
  });

  app.get(`${PREFIX}/templates`, async (req) => {
    requireAdmin(req);
    return catalog.templates();
  });
  app.post(`${PREFIX}/templates/:key/instantiate`, async (req) => {
    requireAdmin(req);
    return catalog.createFromTemplate(parse(z.object({ key: fieldKeySchema }), req.params).key);
  });

  // ─── Assets ──────────────────────────────────────────────────────────────
  app.get(`${PREFIX}/assets`, async (req) => assets.list(requirePrincipal(req), parse(assetQuerySchema, req.query)));
  app.post(`${PREFIX}/assets`, async (req, reply) => {
    const asset = await assets.create(requirePrincipal(req), parse(assetCreateSchema, req.body));
    return reply.status(201).send(asset);
  });
  app.get(`${PREFIX}/assets/:id`, async (req) => assets.get(requirePrincipal(req), parse(idParam, req.params).id));
  app.patch(`${PREFIX}/assets/:id`, async (req) => assets.update(requirePrincipal(req), parse(idParam, req.params).id, parse(assetUpdateSchema, req.body)));
  app.delete(`${PREFIX}/assets/:id`, async (req, reply) => {
    await assets.remove(requirePrincipal(req), parse(idParam, req.params).id);
    return reply.status(204).send();
  });
  app.post(`${PREFIX}/assets/:id/dates/:field/advance`, async (req) => {
    const p = parse(z.object({ id: z.string().uuid(), field: fieldKeySchema }), req.params);
    return assets.advance(requirePrincipal(req), p.id, p.field);
  });
  app.get(`${PREFIX}/assets/:id/activity`, async (req) => assets.activity(requirePrincipal(req), parse(idParam, req.params).id));
  app.get(`${PREFIX}/assets/:id/access`, async (req) => assets.access(requirePrincipal(req), parse(idParam, req.params).id));
  app.get(`${PREFIX}/assets/:id/request`, async (req) => (await requests.forAsset(requirePrincipal(req), parse(idParam, req.params).id)) ?? {});

  // ─── Requests ────────────────────────────────────────────────────────────
  app.get(`${PREFIX}/requests`, async (req) => requests.list(requirePrincipal(req), parse(requestQuerySchema, req.query)));
  app.get(`${PREFIX}/requests/counts`, async (req) => requests.counts(requirePrincipal(req)));
  app.post(`${PREFIX}/requests`, async (req, reply) => reply.status(201).send(await requests.create(requirePrincipal(req), parse(requestCreateSchema, req.body))));
  app.get(`${PREFIX}/requests/:id`, async (req) => requests.get(requirePrincipal(req), parse(idParam, req.params).id));
  app.patch(`${PREFIX}/requests/:id`, async (req) => requests.update(requirePrincipal(req), parse(idParam, req.params).id, parse(requestUpdateSchema, req.body)));
  app.get(`${PREFIX}/requests/:id/events`, async (req) => requests.events(requirePrincipal(req), parse(idParam, req.params).id));
  app.post(`${PREFIX}/requests/:id/actions`, async (req) => requests.act(requirePrincipal(req), parse(idParam, req.params).id, parse(requestActionSchema, req.body)));

  // ─── Search & saved views ────────────────────────────────────────────────
  app.get(`${PREFIX}/search`, async (req) => {
    const q = parse(searchQuerySchema, req.query);
    return search.search(requirePrincipal(req), q.q, q.limit);
  });
  app.get(`${PREFIX}/views`, async (req) => search.views(requirePrincipal(req)));
  app.post(`${PREFIX}/views`, async (req) => search.createView(requirePrincipal(req), parse(savedViewInputSchema, req.body)));
  app.put(`${PREFIX}/views/:id`, async (req) => search.updateView(requirePrincipal(req), parse(idParam, req.params).id, parse(savedViewInputSchema, req.body)));
  app.delete(`${PREFIX}/views/:id`, async (req, reply) => {
    await search.deleteView(requirePrincipal(req), parse(idParam, req.params).id);
    return reply.status(204).send();
  });
}
