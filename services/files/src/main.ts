import { main, runService } from '@am/platform/node';
import { S3ObjectStorage } from './infrastructure/adapters.js';
import { RegistryAssetAccess } from './infrastructure/registry-access.js';
import { defineFilesService } from './service.js';

main(() =>
  runService(
    defineFilesService({
      storage: (config) =>
        new S3ObjectStorage({
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
        }),
      assetAccess: (config) => new RegistryAssetAccess(config.REGISTRY_URL),
    }),
  ),
);
