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
