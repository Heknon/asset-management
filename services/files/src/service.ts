import { defineService, type BaseConfig } from '@am/platform';
import type { z } from 'zod';
import type { AssetAccess, ObjectStorage } from './application/ports.js';
import { FileService } from './application/file-service.js';
import { filesConfig } from './config.js';
import { migrations, PgFileStore, type FilesDB } from './infrastructure/persistence.js';
import { registerRoutes } from './http/routes.js';

export type { AssetAccess, ObjectStorage } from './application/ports.js';

export type FilesConfig = BaseConfig & z.infer<z.ZodObject<typeof filesConfig>>;

/** Where bytes live and who decides access: S3 and the registry over HTTP on the server; the browser's own stores in the browser runtime. */
export interface FilesAdapters {
  storage(config: FilesConfig): ObjectStorage;
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
      registerRoutes(app, files);

      await bus.subscribe('files', 'asset.deleted', (e) => files.onAssetDeleted(e.assetId));

      // Hourly on the server; on each cron run when serverless.
      await bus.schedule('files.purge-abandoned', '17 * * * *', async () => {
        const n = await files.purgeAbandoned(new Date(Date.now() - 24 * 3_600_000));
        if (n) logger.info({ removed: n }, 'purged abandoned uploads');
      });
    },
  });
export { RegistryAssetAccess } from './infrastructure/registry-access.js';
