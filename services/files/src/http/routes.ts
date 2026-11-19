import { uploadRequestSchema } from '@am/core';
import { extractToken, parse, requirePrincipal } from '@am/platform';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Caller, FileService } from '../application/file-service.js';

const PREFIX = '/api/files';
const idParam = z.object({ id: z.string().uuid() });

function caller(req: FastifyRequest): Caller {
  return { principal: requirePrincipal(req), token: extractToken(req.headers, req.cookies ?? {})! };
}

export function registerRoutes(app: FastifyInstance, files: FileService): void {
  app.get(`${PREFIX}/assets/:id`, async (req) => files.list(caller(req), parse(idParam, req.params).id));
  app.post(`${PREFIX}/uploads`, async (req) => files.requestUpload(caller(req), parse(uploadRequestSchema, req.body)));
  app.post(`${PREFIX}/:id/complete`, async (req) => files.completeUpload(caller(req), parse(idParam, req.params).id));
  app.get(`${PREFIX}/:id/url`, async (req) => {
    const { mode } = parse(z.object({ mode: z.enum(['preview', 'download']).default('preview') }), req.query);
    return files.signedUrl(caller(req), parse(idParam, req.params).id, mode);
  });
  app.delete(`${PREFIX}/:id`, async (req, reply) => {
    await files.remove(caller(req), parse(idParam, req.params).id);
    return reply.status(204).send();
  });
}
