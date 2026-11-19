import { envBool } from '@am/platform';
import { z } from 'zod';

export const filesConfig = {
  S3_BUCKET: z.string().min(3),
  S3_REGION: z.string().default('us-east-1'),
  /** S3-compatible endpoint used by the service (MinIO, Ceph/ODF, NooBaa). Omit for AWS. */
  S3_ENDPOINT: z.string().url().optional(),
  /** Endpoint browsers use for presigned URLs, when it differs from S3_ENDPOINT. */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: envBool(false),
  /** Static credentials; omit to use the default AWS chain (IRSA, instance profile, env). */
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_SSE: z.enum(['none', 'AES256', 'aws:kms']).default('AES256'),
  S3_KMS_KEY_ID: z.string().optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /** Internal URL of the registry service, used to authorise access to an asset's files. */
  REGISTRY_URL: z.string().url().default('http://registry:8080'),
};
