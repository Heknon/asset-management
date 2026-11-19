import {
  assetCreateSchema,
  assetExportSchema,
  assetQuerySchema,
  catalogInputSchema,
  importRequestSchema,
  typeVariantInputSchema,
  catalogQuerySchema,
  catalogShareInputSchema,
  commentInputSchema,
  csvFilename,
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
  renewalRequestSchema,
  workflowSchema,
} from '@am/core';
import { AppError, subjectKinds } from '@am/core';
import { metrics, parse, requirePrincipal, textStream } from '@am/platform';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssetService } from '../application/asset-service.js';
import type { CatalogService } from '../application/catalog-service.js';
import type { CommentService } from '../application/comment-service.js';
import type { ExportService } from '../application/export-service.js';
import type { ImportService } from '../application/import-service.js';
import type { TypeService } from '../application/type-service.js';
import type { VariantService } from '../application/variant-service.js';
import type { RequestService } from '../application/request-service.js';
import type { SearchService } from '../application/search-service.js';

const PREFIX = '/api/registry';
const idParam = z.object({ id: z.string().uuid() });
const exportsTotal = metrics.counter({ name: 'am_exports_total', help: 'CSV exports', labelNames: ['kind'] });
const exportedRows = metrics.counter({ name: 'am_exported_rows_total', help: 'Rows exported to CSV', labelNames: ['kind'] });

export interface Services {
  types: TypeService;
  variants: VariantService;
  assets: AssetService;
  catalogs: CatalogService;
  comments: CommentService;
  exports: ExportService;
  imports: ImportService;
  requests: RequestService;
  search: SearchService;
}

export interface Features {
  /** CSV export of tables (on by default; CSV_EXPORT_ENABLED=false turns it off for everyone). */
  csvExport: boolean;
}

export function registerRoutes(app: FastifyInstance, { types, variants, assets, catalogs, comments, exports, imports, requests, search }: Services, features: Features): void {
  app.get(`${PREFIX}/features`, async (req) => {
    requirePrincipal(req);
    return features;
  });

  // ─── Date kinds ──────────────────────────────────────────────────────────
  app.get(`${PREFIX}/date-kinds`, async (req) => {
    requirePrincipal(req);
    return types.listDateKinds();
  });
  app.post(`${PREFIX}/date-kinds`, async (req) => {
    await types.assertCanManage(requirePrincipal(req));
    return types.createDateKind(parse(dateKindInputSchema, req.body));
  });
  app.put(`${PREFIX}/date-kinds/:id`, async (req) => {
    await types.assertCanManage(requirePrincipal(req));
    const body = parse(dateKindInputSchema.extend({ archived: z.boolean().default(false) }), req.body);
    return types.updateDateKind(parse(idParam, req.params).id, body);
  });

  // ─── Asset types (templates) ─────────────────────────────────────────────
  app.get(`${PREFIX}/asset-types`, async (req) => {
    requirePrincipal(req);
    const { archived } = parse(z.object({ archived: z.enum(['true', 'false']).default('false') }), req.query);
    return types.listTypes(archived === 'true');
  });
  app.get(`${PREFIX}/asset-types/:id`, async (req) => {
    requirePrincipal(req);
    return types.getType(parse(idParam, req.params).id);
  });
  app.post(`${PREFIX}/asset-types`, async (req) => {
    await types.assertCanManage(requirePrincipal(req));
    return types.createType(parse(assetTypeInputSchema, req.body));
  });
  app.put(`${PREFIX}/asset-types/:id`, async (req) => {
    await types.assertCanManage(requirePrincipal(req));
    const body = parse(assetTypeInputSchema.extend({ version: z.number().int().positive() }), req.body);
    const { version, ...input } = body;
    return types.updateType(parse(idParam, req.params).id, input, version);
  });
  // ─── Request workflows ───────────────────────────────────────────────────
  app.get(`${PREFIX}/workflows/default`, async (req) => {
    requirePrincipal(req);
    return types.organizationWorkflow();
  });
  app.put(`${PREFIX}/workflows/default`, async (req) => {
    await types.assertCanManage(requirePrincipal(req));
    return types.setOrganizationWorkflow(parse(workflowSchema, req.body));
  });
  app.post(`${PREFIX}/asset-types/:id/archive`, async (req) => {
    await types.assertCanManage(requirePrincipal(req));
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    return types.setArchived(parse(idParam, req.params).id, archived);
  });

  // ─── Team variants (a unit's extension of a template) ────────────────────
  app.get(`${PREFIX}/variants`, async (req) => {
    requirePrincipal(req);
    const q = parse(z.object({ assetTypeId: z.string().uuid().optional(), unitId: z.string().uuid().optional(), archived: z.enum(['true', 'false']).default('false') }), req.query);
    return variants.list({ assetTypeId: q.assetTypeId, unitId: q.unitId, includeArchived: q.archived === 'true' });
  });
  app.get(`${PREFIX}/variants/:id`, async (req) => {
    requirePrincipal(req);
    return variants.get(parse(idParam, req.params).id);
  });
  app.post(`${PREFIX}/asset-types/:id/variants`, async (req, reply) =>
    reply.status(201).send(await variants.create(requirePrincipal(req), parse(idParam, req.params).id, parse(typeVariantInputSchema, req.body))),
  );
  app.put(`${PREFIX}/variants/:id`, async (req) => {
    const { version, ...input } = parse(typeVariantInputSchema.omit({ unitId: true }).extend({ version: z.number().int().positive() }), req.body);
    return variants.update(requirePrincipal(req), parse(idParam, req.params).id, input, version);
  });
  app.post(`${PREFIX}/variants/:id/archive`, async (req) => {
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    return variants.setArchived(requirePrincipal(req), parse(idParam, req.params).id, archived);
  });

  app.get(`${PREFIX}/templates`, async (req) => {
    await types.assertCanManage(requirePrincipal(req));
    return types.templates();
  });
  app.post(`${PREFIX}/templates/:key/instantiate`, async (req) => {
    await types.assertCanManage(requirePrincipal(req));
    return types.createFromTemplate(parse(z.object({ key: fieldKeySchema }), req.params).key);
  });

  // ─── Assets ──────────────────────────────────────────────────────────────
  app.get(`${PREFIX}/assets`, async (req) => assets.list(requirePrincipal(req), parse(assetQuerySchema, req.query)));
  app.get(`${PREFIX}/assets/export.csv`, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!features.csvExport) throw AppError.forbidden('CSV export is turned off');
    await exports.assertCanExport(principal);
    const query = parse(assetExportSchema.extend({ title: z.string().max(120).default('Assets') }), req.query);
    const { title, ...rest } = query;
    const filename = csvFilename(title, new Date().toISOString().slice(0, 10));
    exportsTotal.inc({ kind: 'assets' });
    const csv = exports.assetsCsv(principal, rest, (rows) => {
      exportedRows.inc({ kind: 'assets' }, rows);
      req.log.info({ export: 'assets', rows, userId: principal.userId, query: rest }, 'csv export');
    });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('cache-control', 'no-store')
      .send(textStream(csv));
  });
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
  app.post(`${PREFIX}/assets/:id/renewal-requests`, async (req, reply) =>
    reply.status(201).send(await requests.requestRenewal(requirePrincipal(req), parse(idParam, req.params).id, parse(renewalRequestSchema, req.body))),
  );
  app.get(`${PREFIX}/assets/:id/request`, async (req) => (await requests.forAsset(requirePrincipal(req), parse(idParam, req.params).id)) ?? {});

  // ─── Imports ─────────────────────────────────────────────────────────────
  app.post(`${PREFIX}/imports`, async (req) => imports.run(requirePrincipal(req), parse(importRequestSchema, req.body)));
  app.get(`${PREFIX}/imports`, async (req) => imports.list(requirePrincipal(req)));
  app.delete(`${PREFIX}/imports/:id`, async (req) => imports.undo(requirePrincipal(req), parse(idParam, req.params).id));

  // ─── Conversations ───────────────────────────────────────────────────────
  app.get(`${PREFIX}/assets/:id/comments`, async (req) => comments.list(requirePrincipal(req), parse(idParam, req.params).id));
  app.post(`${PREFIX}/assets/:id/comments`, async (req, reply) =>
    reply.status(201).send(await comments.create(requirePrincipal(req), parse(idParam, req.params).id, parse(commentInputSchema, req.body))),
  );
  app.put(`${PREFIX}/comments/:id`, async (req) => comments.update(requirePrincipal(req), parse(idParam, req.params).id, parse(commentInputSchema, req.body)));
  app.delete(`${PREFIX}/comments/:id`, async (req) => comments.remove(requirePrincipal(req), parse(idParam, req.params).id));

  // ─── Catalogs & sharing ──────────────────────────────────────────────────
  app.get(`${PREFIX}/catalogs`, async (req) => catalogs.list(requirePrincipal(req), parse(catalogQuerySchema, req.query)));
  app.post(`${PREFIX}/catalogs`, async (req, reply) => reply.status(201).send(await catalogs.create(requirePrincipal(req), parse(catalogInputSchema, req.body))));
  app.get(`${PREFIX}/catalogs/:id`, async (req) => catalogs.get(requirePrincipal(req), parse(idParam, req.params).id));
  app.put(`${PREFIX}/catalogs/:id`, async (req) =>
    catalogs.update(requirePrincipal(req), parse(idParam, req.params).id, parse(catalogInputSchema.omit({ unitId: true }), req.body)),
  );
  app.delete(`${PREFIX}/catalogs/:id`, async (req, reply) => {
    await catalogs.remove(requirePrincipal(req), parse(idParam, req.params).id);
    return reply.status(204).send();
  });
  app.post(`${PREFIX}/catalogs/:id/shares`, async (req) => catalogs.share(requirePrincipal(req), parse(idParam, req.params).id, parse(catalogShareInputSchema, req.body)));
  app.delete(`${PREFIX}/catalogs/:id/shares/:kind/:subjectId`, async (req) => {
    const p = parse(z.object({ id: z.string().uuid(), kind: z.enum(subjectKinds), subjectId: z.string().uuid() }), req.params);
    return catalogs.unshare(requirePrincipal(req), p.id, { kind: p.kind, id: p.subjectId });
  });

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
