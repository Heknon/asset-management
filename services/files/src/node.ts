import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { S3ObjectStorage } from './infrastructure/adapters.js';
import { RegistryAssetAccess } from './infrastructure/registry-access.js';
import type { FilesAdapters } from './service.js';

export interface NodeFilesOptions {
  /** Lets a single-process runtime reach the registry in-process instead of over the network. */
  fetcher?: typeof fetch;
  /** Credentials from the runtime (e.g. Vercel's OIDC role); otherwise S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY or the default chain. */
  credentials?: S3ClientConfig['credentials'];
}

/** The files service on Node (server and serverless): bytes in S3, access decided by the registry. */
export function nodeFilesAdapters(opts: NodeFilesOptions = {}): FilesAdapters {
  return {
    storage: (config) =>
      new S3ObjectStorage({
        bucket: config.S3_BUCKET,
        prefix: config.S3_PREFIX,
        region: config.S3_REGION,
        endpoint: config.S3_ENDPOINT,
        publicEndpoint: config.S3_PUBLIC_ENDPOINT,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        sse: config.S3_SSE,
        kmsKeyId: config.S3_KMS_KEY_ID,
        ttlSeconds: config.URL_TTL_SECONDS,
        credentials: opts.credentials,
      }),
    assetAccess: (config) => new RegistryAssetAccess(config.REGISTRY_URL, opts.fetcher),
  };
}
export { S3ObjectStorage };
