import { defineService, registerBackup, type BaseConfig } from '@am/platform';
import type { z } from 'zod';
import { BackupService } from './application/backup-service.js';
import type { AssetAccess, BackupStorage, ObjectStorage } from './application/ports.js';
import { FileService } from './application/file-service.js';
import { filesConfig } from './config.js';
import { migrations, PgFileStore, type FilesDB } from './infrastructure/persistence.js';
import { registerRoutes } from './http/routes.js';

export type { AssetAccess, BackupStorage, ObjectStorage } from './application/ports.js';

export type FilesConfig = BaseConfig & z.infer<z.ZodObject<typeof filesConfig>>;

/** Where bytes live and who decides access: S3 and the registry over HTTP on the server; the browser's own stores in the browser runtime. */
export interface FilesAdapters {
  /** Storage the service can also list, read and write itself makes backups to storage possible (S3; not the in-browser store). */
  storage(config: FilesConfig): ObjectStorage & Partial<BackupStorage>;
  assetAccess(config: FilesConfig): AssetAccess;
}

/** Documents attached to assets: upload tickets, signed URLs, clean-up. */
export const defineFilesService = (adapters: FilesAdapters) =>
  defineService<FilesDB, typeof filesConfig>({
    name: 'files',
    config: filesConfig,
    migrations,
    async register({ config, database, app, bus, logger }) {
      const storage = adapters.storage(config);
      if (config.S3_CREATE_BUCKET && storage.ensureBucket && (await storage.ensureBucket())) logger.info({ bucket: config.S3_BUCKET }, 'created the document bucket');
      const files = new FileService(new PgFileStore(database.db), storage, adapters.assetAccess(config), config.MAX_UPLOAD_BYTES);
      const backups =
        config.BACKUP_ENABLED && storage.presignPrefixUpload
          ? new BackupService(storage as ObjectStorage & BackupStorage, {
              origin: config.PUBLIC_URL.replace(/\/$/, ''),
              schedule: config.BACKUP_NIGHTLY_CRON,
              publish: (e) => bus.publish('backup.requested', e),
              log: (fields, message) => logger.info({ audit: 'backup', ...fields }, message),
            })
          : null;
      registerRoutes(app, files, { backup: config.BACKUP_ENABLED }, backups);
      if (backups) {
        await bus.subscribe('files', 'backup.part', (e) => backups.onPart(e.backupId));
        await bus.schedule('files.backup-nightly', config.BACKUP_NIGHTLY_CRON, () => backups.nightly());
      }
      await registerBackup(app, { name: 'files', database, logger, enabled: config.BACKUP_ENABLED, bus });

      await bus.subscribe('files', 'asset.deleted', (e) => files.onAssetDeleted(e.assetId));

      // Hourly on the server; on each cron run when serverless.
      await bus.schedule('files.purge-abandoned', '17 * * * *', async () => {
        const n = await files.purgeAbandoned(new Date(Date.now() - 24 * 3_600_000));
        if (n) logger.info({ removed: n }, 'purged abandoned uploads');
      });
    },
  });
export { RegistryAssetAccess } from './infrastructure/registry-access.js';
