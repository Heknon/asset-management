import type { AccessCheck } from '@am/core';
import type { StoredFile } from '../domain/file.js';

export interface FileStore {
  insert(file: Omit<StoredFile, 'createdAt'>): Promise<StoredFile>;
  get(id: string): Promise<StoredFile | null>;
  listByAsset(assetId: string): Promise<StoredFile[]>;
  markReady(id: string, etag: string | null): Promise<StoredFile>;
  delete(id: string): Promise<void>;
  deleteByAsset(assetId: string): Promise<StoredFile[]>;
  stalePending(olderThan: Date): Promise<StoredFile[]>;
}

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  expiresAt: Date;
}

/** Object storage port; the only place that knows about S3. */
export interface ObjectStorage {
  presignUpload(key: string, contentType: string, maxBytes: number): Promise<PresignedUpload>;
  presignDownload(key: string, opts: { contentType: string; disposition: string }): Promise<{ url: string; expiresAt: Date }>;
  head(key: string): Promise<{ size: number; contentType: string | null; etag: string | null } | null>;
  delete(keys: string[]): Promise<void>;
  /** Creates the bucket if it does not exist yet (in-cluster storage); returns whether it did. */
  ensureBucket?(): Promise<boolean>;
}

/** Asks the registry what the caller may do with an asset (the registry owns asset authorisation). */
export interface AssetAccess {
  check(callerToken: string, assetId: string): Promise<AccessCheck | null>;
}

export interface StoredObject {
  key: string;
  size: number;
  modifiedAt: Date;
}

/** Writes a large object piece by piece (an S3 multipart upload). */
export interface ObjectWriter {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * What keeping backups in storage needs on top of documents: the service
 * itself lists, reads and writes objects (documents only ever pass presigned
 * links around). Runtimes without real object storage do not provide it.
 */
export interface BackupStorage {
  list(prefix: string): Promise<StoredObject[]>;
  read(key: string): Promise<Uint8Array | null>;
  put(key: string, body: string, contentType: string): Promise<void>;
  writer(key: string, contentType: string): Promise<ObjectWriter>;
  /** A form upload, usable from inside the cluster, for any key that starts with `keyPrefix`. */
  presignPrefixUpload(prefix: string, maxBytes: number, ttlSeconds: number): Promise<{ url: string; fields: Record<string, string>; keyPrefix: string }>;
}
