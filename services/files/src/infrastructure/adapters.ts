import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError, type AccessCheck } from '@am/core';
import type { AssetAccess, ObjectStorage, PresignedUpload } from '../application/ports.js';

export interface S3Settings {
  bucket: string;
  region: string;
  endpoint?: string;
  publicEndpoint?: string;
  forcePathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sse: 'none' | 'AES256' | 'aws:kms';
  kmsKeyId?: string;
  ttlSeconds: number;
}

export class S3ObjectStorage implements ObjectStorage {
  /** `internal` talks to S3 from the pod; `signer` produces URLs that browsers can reach. */
  private readonly internal: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly s: S3Settings) {
    const base: S3ClientConfig = {
      region: s.region,
      forcePathStyle: s.forcePathStyle,
      ...(s.accessKeyId && s.secretAccessKey && { credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } }),
    };
    this.internal = new S3Client({ ...base, ...(s.endpoint && { endpoint: s.endpoint }) });
    const pub = s.publicEndpoint ?? s.endpoint;
    this.signer = new S3Client({ ...base, ...(pub && { endpoint: pub }) });
  }

  private sseFields(): Record<string, string> {
    if (this.s.sse === 'none') return {};
    return {
      'x-amz-server-side-encryption': this.s.sse,
      ...(this.s.sse === 'aws:kms' && this.s.kmsKeyId && { 'x-amz-server-side-encryption-aws-kms-key-id': this.s.kmsKeyId }),
    };
  }

  async presignUpload(key: string, contentType: string, maxBytes: number): Promise<PresignedUpload> {
    const fields = { 'Content-Type': contentType, ...this.sseFields() };
    const { url, fields: signed } = await createPresignedPost(this.signer, {
      Bucket: this.s.bucket,
      Key: key,
      Fields: fields,
      Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', contentType], ...Object.entries(this.sseFields()).map(([k, v]) => ({ [k]: v }))],
      Expires: this.s.ttlSeconds,
    });
    return { url, fields: signed, expiresAt: new Date(Date.now() + this.s.ttlSeconds * 1000) };
  }

  async presignDownload(key: string, opts: { contentType: string; disposition: string }) {
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({ Bucket: this.s.bucket, Key: key, ResponseContentType: opts.contentType, ResponseContentDisposition: opts.disposition }),
      { expiresIn: this.s.ttlSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + this.s.ttlSeconds * 1000) };
  }

  async head(key: string) {
    try {
      const r = await this.internal.send(new HeadObjectCommand({ Bucket: this.s.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? null, etag: r.ETag ?? null };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async delete(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await this.internal.send(new DeleteObjectsCommand({ Bucket: this.s.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
    }
  }
}

/** Forwards the caller's token to the registry, which owns asset authorisation. */
export class RegistryAssetAccess implements AssetAccess {
  constructor(private readonly baseUrl: string) {}

  async check(token: string, assetId: string): Promise<AccessCheck | null> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/registry/assets/${encodeURIComponent(assetId)}/access`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res) throw new AppError('unavailable', 'The asset registry is not reachable');
    if (res.status === 404 || res.status === 403) return null;
    if (res.status === 401) throw AppError.unauthenticated();
    if (!res.ok) throw new AppError('unavailable', 'The asset registry is not reachable');
    return (await res.json()) as AccessCheck;
  }
}
