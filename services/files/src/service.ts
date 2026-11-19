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
    async register({ config, database, app, bus, logger, onClose }) {
      const files = new FileService(new PgFileStore(database.db), adapters.storage(config), adapters.assetAccess(config), config.MAX_UPLOAD_BYTES);
      registerRoutes(app, files);

      await bus.subscribe('files', 'asset.deleted', (e) => files.onAssetDeleted(e.assetId));

      const sweep = setInterval(() => {
        files
          .purgeAbandoned(new Date(Date.now() - 24 * 3_600_000))
          .then((n) => n && logger.info({ removed: n }, 'purged abandoned uploads'))
          .catch((err) => logger.warn({ err }, 'abandoned upload purge failed'));
      }, 3_600_000);
      onClose(() => clearInterval(sweep));
    },
  });
export { RegistryAssetAccess } from './infrastructure/registry-access.js';
