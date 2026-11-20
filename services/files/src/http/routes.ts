import { AppError, uploadRequestSchema } from '@am/core';
import { extractToken, parse, requireAdmin, requirePrincipal } from '@am/platform';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Caller, FileService } from '../application/file-service.js';

const PREFIX = '/api/files';
const idParam = z.object({ id: z.string().uuid() });

function caller(req: FastifyRequest): Caller {
  return { principal: requirePrincipal(req), token: extractToken(req.headers, req.cookies ?? {})! };
}

export interface Features {
  /** Administrators may copy documents out for a backup and put them back on a restore (BACKUP_ENABLED). */
  backup: boolean;
}

const restoredObjectSchema = z.object({ objectKey: z.string().max(200), contentType: z.string().min(1).max(200), size: z.number().int().positive() });

export function registerRoutes(app: FastifyInstance, files: FileService, features: Features): void {
  const backupAdmin = (req: FastifyRequest) => {
    requireAdmin(req);
    if (!features.backup) throw AppError.forbidden('Backup and restore are turned off for this installation');
  };
  // The bytes behind the rows of a backup (see registerBackupRoutes for the rows themselves).
  app.get(`${PREFIX}/backup/objects/:id/url`, async (req) => {
    backupAdmin(req);
    return files.backupDownload(parse(idParam, req.params).id);
  });
  app.post(`${PREFIX}/backup/objects`, async (req) => {
    backupAdmin(req);
    return files.backupUpload(parse(restoredObjectSchema, req.body));
  });

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
