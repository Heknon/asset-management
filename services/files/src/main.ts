import { main, runService } from '@am/platform';
import { FileService } from './application/file-service.js';
import { filesConfig } from './config.js';
import { RegistryAssetAccess, S3ObjectStorage } from './infrastructure/adapters.js';
import { migrations, PgFileStore, type FilesDB } from './infrastructure/persistence.js';
import { registerRoutes } from './http/routes.js';

main(() =>
  runService<FilesDB, typeof filesConfig>({
    name: 'files',
    config: filesConfig,
    migrations,
    async register({ config, database, app, bus, logger, onClose }) {
      const storage = new S3ObjectStorage({
        bucket: config.S3_BUCKET,
        region: config.S3_REGION,
        endpoint: config.S3_ENDPOINT,
        publicEndpoint: config.S3_PUBLIC_ENDPOINT,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        sse: config.S3_SSE,
        kmsKeyId: config.S3_KMS_KEY_ID,
        ttlSeconds: config.URL_TTL_SECONDS,
      });
      const files = new FileService(new PgFileStore(database.db), storage, new RegistryAssetAccess(config.REGISTRY_URL), config.MAX_UPLOAD_BYTES);
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
  }),
);
