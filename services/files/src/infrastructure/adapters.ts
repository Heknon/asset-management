import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BackupStorage, ObjectStorage, ObjectWriter, PresignedUpload, StoredObject } from '../application/ports.js';

export interface S3Settings {
  bucket: string;
  /** Prepended to every object key, so environments can share one bucket (e.g. `dev/`). */
  prefix?: string;
  region: string;
  endpoint?: string;
  publicEndpoint?: string;
  forcePathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sse: 'none' | 'AES256' | 'aws:kms';
  kmsKeyId?: string;
  ttlSeconds: number;
  /** Credentials from the runtime (e.g. a role assumed with Vercel's OIDC token); otherwise the keys above or the default chain. */
  credentials?: S3ClientConfig['credentials'];
}

/** S3 asks for at least 5 MB per part of a multipart upload (except the last). */
const PART_BYTES = 8 * 1_048_576;

export class S3ObjectStorage implements ObjectStorage, BackupStorage {
  /** `internal` talks to S3 from the pod; `signer` produces URLs that browsers can reach. */
  private readonly internal: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly s: S3Settings) {
    const base: S3ClientConfig = {
      region: s.region,
      forcePathStyle: s.forcePathStyle,
      ...(s.credentials
        ? { credentials: s.credentials }
        : s.accessKeyId && s.secretAccessKey && { credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } }),
    };
    this.internal = new S3Client({ ...base, ...(s.endpoint && { endpoint: s.endpoint }) });
    const pub = s.publicEndpoint ?? s.endpoint;
    this.signer = new S3Client({ ...base, ...(pub && { endpoint: pub }) });
  }

  async ensureBucket(): Promise<boolean> {
    const exists = await this.internal.send(new HeadBucketCommand({ Bucket: this.s.bucket })).then(
      () => true,
      (err: { name?: string; $metadata?: { httpStatusCode?: number } }) => {
        if (err.name === 'NotFound' || err.name === 'NoSuchBucket' || err.$metadata?.httpStatusCode === 404) return false;
        throw err;
      },
    );
    if (exists) return false;
    await this.internal.send(new CreateBucketCommand({ Bucket: this.s.bucket }));
    return true;
  }

  private key(key: string): string {
    return `${this.s.prefix ?? ''}${key}`;
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
      Key: this.key(key),
      Fields: fields,
      Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', contentType], ...Object.entries(this.sseFields()).map(([k, v]) => ({ [k]: v }))],
      Expires: this.s.ttlSeconds,
    });
    return { url, fields: signed, expiresAt: new Date(Date.now() + this.s.ttlSeconds * 1000) };
  }

  async presignDownload(key: string, opts: { contentType: string; disposition: string }) {
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({ Bucket: this.s.bucket, Key: this.key(key), ResponseContentType: opts.contentType, ResponseContentDisposition: opts.disposition }),
      { expiresIn: this.s.ttlSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + this.s.ttlSeconds * 1000) };
  }

  async head(key: string) {
    try {
      const r = await this.internal.send(new HeadObjectCommand({ Bucket: this.s.bucket, Key: this.key(key) }));
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
      await this.internal.send(new DeleteObjectsCommand({ Bucket: this.s.bucket, Delete: { Objects: chunk.map((k) => ({ Key: this.key(k) })), Quiet: true } }));
    }
  }

  /** Encryption at rest for objects the service writes itself (uploads from browsers carry it in the signed form). */
  private sseParams() {
    if (this.s.sse === 'none') return {};
    return { ServerSideEncryption: this.s.sse, ...(this.s.sse === 'aws:kms' && this.s.kmsKeyId && { SSEKMSKeyId: this.s.kmsKeyId }) };
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    const strip = (this.s.prefix ?? '').length;
    let token: string | undefined;
    do {
      const page = await this.internal.send(new ListObjectsV2Command({ Bucket: this.s.bucket, Prefix: this.key(prefix), ContinuationToken: token }));
      for (const o of page.Contents ?? []) if (o.Key) out.push({ key: o.Key.slice(strip), size: o.Size ?? 0, modifiedAt: o.LastModified ?? new Date(0) });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async read(key: string): Promise<Uint8Array | null> {
    try {
      const r = await this.internal.send(new GetObjectCommand({ Bucket: this.s.bucket, Key: this.key(key) }));
      return r.Body ? await r.Body.transformToByteArray() : new Uint8Array(0);
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async put(key: string, body: string, contentType: string): Promise<void> {
    await this.internal.send(new PutObjectCommand({ Bucket: this.s.bucket, Key: this.key(key), Body: body, ContentType: contentType, ...this.sseParams() }));
  }

  /** Small objects go up in one request; larger ones as a multipart upload, a part at a time. */
  async writer(key: string, contentType: string): Promise<ObjectWriter> {
    const target = { Bucket: this.s.bucket, Key: this.key(key) };
    let uploadId: string | undefined;
    const parts: Array<{ ETag: string | undefined; PartNumber: number }> = [];
    let pending: Uint8Array[] = [];
    let size = 0;
    const take = () => {
      const body = new Uint8Array(size);
      let at = 0;
      for (const p of pending) {
        body.set(p, at);
        at += p.length;
      }
      pending = [];
      size = 0;
      return body;
    };
    const uploadPart = async () => {
      uploadId ??= (await this.internal.send(new CreateMultipartUploadCommand({ ...target, ContentType: contentType, ...this.sseParams() }))).UploadId;
      const PartNumber = parts.length + 1;
      const r = await this.internal.send(new UploadPartCommand({ ...target, UploadId: uploadId, PartNumber, Body: take() }));
      parts.push({ ETag: r.ETag, PartNumber });
    };
    return {
      write: async (bytes) => {
        pending.push(bytes);
        size += bytes.length;
        if (size >= PART_BYTES) await uploadPart();
      },
      close: async () => {
        if (!uploadId) {
          await this.internal.send(new PutObjectCommand({ ...target, Body: take(), ContentType: contentType, ...this.sseParams() }));
          return;
        }
        if (size) await uploadPart();
        await this.internal.send(new CompleteMultipartUploadCommand({ ...target, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
      },
      abort: async () => {
        if (uploadId) await this.internal.send(new AbortMultipartUploadCommand({ ...target, UploadId: uploadId })).catch(() => undefined);
      },
    };
  }

  /** Signed against the endpoint the pods use: the other services upload with it, not browsers. */
  async presignPrefixUpload(prefix: string, maxBytes: number, ttlSeconds: number) {
    const keyPrefix = this.key(prefix);
    const { url, fields } = await createPresignedPost(this.internal, {
      Bucket: this.s.bucket,
      // "${filename}" makes the policy accept any key under the prefix.
      Key: `${keyPrefix}\${filename}`,
      Fields: this.sseFields(),
      Conditions: [['content-length-range', 0, maxBytes], ...Object.entries(this.sseFields()).map(([k, v]) => ({ [k]: v }))],
      Expires: ttlSeconds,
    });
    return { url, fields, keyPrefix };
  }
}
