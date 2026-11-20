import { AppError, storedBackupSettingsSchema, uploadRequestSchema, type StoredBackups } from '@am/core';
import { extractToken, parse, requireAdmin, requirePrincipal } from '@am/platform';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BackupService } from '../application/backup-service.js';
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

const backupKey = z.object({ key: z.string().max(200) });
const noStoredBackups: StoredBackups = { available: false, nightly: false, keepDays: 3, schedule: '', backups: [], running: [] };

/** `backups` is null where backups cannot be kept in storage (the in-browser runtime, or BACKUP_ENABLED=false). */
export function registerRoutes(app: FastifyInstance, files: FileService, features: Features, backups: BackupService | null = null): void {
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

  // Backups kept in storage: the nightly one and "Back up now".
  const stored = (req: FastifyRequest) => {
    const principal = requireAdmin(req);
    if (!features.backup) throw AppError.forbidden('Backup and restore are turned off for this installation');
    if (!backups) throw AppError.conflict('This installation has no storage to keep backups in');
    return { principal, backups };
  };
  app.get(`${PREFIX}/backup/stored`, async (req) => {
    backupAdmin(req);
    return backups ? backups.status() : noStoredBackups;
  });
  app.post(`${PREFIX}/backup/stored`, async (req) => {
    const { principal, backups } = stored(req);
    return backups.request('manual', principal.displayName);
  });
  app.put(`${PREFIX}/backup/stored/settings`, async (req) => {
    const { principal, backups } = stored(req);
    const settings = await backups.saveSettings(parse(storedBackupSettingsSchema, req.body));
    req.log.info({ audit: 'backup', action: 'nightly settings', userId: principal.userId, username: principal.username, ...settings }, 'backup: nightly settings changed');
    return settings;
  });
  app.get(`${PREFIX}/backup/stored/url`, async (req) => {
    const { principal, backups } = stored(req);
    const { key } = parse(backupKey, req.query);
    req.log.info({ audit: 'backup', action: 'download stored', userId: principal.userId, username: principal.username, key }, 'backup: download stored');
    return backups.downloadUrl(key);
  });
  app.delete(`${PREFIX}/backup/stored`, async (req, reply) => {
    const { principal, backups } = stored(req);
    const { key } = parse(backupKey, req.query);
    await backups.remove(key);
    req.log.info({ audit: 'backup', action: 'delete stored', userId: principal.userId, username: principal.username, key }, 'backup: deleted stored');
    return reply.status(204).send();
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
