import { AppError, atLeast, previewKindOf, type AccessLevel, type FileRecord, type Principal, type SignedUrl, type UploadRequest, type UploadTicket } from '@am/core';
import { contentDisposition, objectKeyFor, toRecord, validateUpload } from '../domain/file.js';
import type { AssetAccess, FileStore, ObjectStorage } from './ports.js';

export interface Caller {
  principal: Principal;
  token: string;
}

/**
 * Documents attached to assets. Bytes never pass through this service:
 * browsers upload and download directly against S3 with short-lived presigned
 * requests, and this service only authorises and records them.
 */
export class FileService {
  constructor(
    private readonly files: FileStore,
    private readonly storage: ObjectStorage,
    private readonly access: AssetAccess,
    private readonly maxBytes: number,
  ) {}

  async list(caller: Caller, assetId: string): Promise<FileRecord[]> {
    await this.require(caller, assetId, 'view');
    return (await this.files.listByAsset(assetId)).filter((f) => f.status === 'ready').map(toRecord);
  }

  async requestUpload(caller: Caller, input: UploadRequest): Promise<UploadTicket> {
    await this.require(caller, input.assetId, 'edit');
    const { filename, contentType } = validateUpload(input, this.maxBytes);
    const id = globalThis.crypto.randomUUID();
    const objectKey = objectKeyFor(input.assetId, id);
    const file = await this.files.insert({
      id,
      assetId: input.assetId,
      objectKey,
      filename,
      contentType,
      size: input.size,
      status: 'pending',
      etag: null,
      uploadedBy: caller.principal.userId,
      uploadedByName: caller.principal.displayName,
    });
    // The signed policy pins key, content type and a size ceiling, so the browser cannot upload anything else.
    const upload = await this.storage.presignUpload(objectKey, contentType, Math.min(this.maxBytes, input.size));
    return { file: toRecord(file), upload: { url: upload.url, fields: upload.fields, expiresAt: upload.expiresAt.toISOString() } };
  }

  /** Confirms the object actually landed in S3 with the declared type and size. */
  async completeUpload(caller: Caller, fileId: string): Promise<FileRecord> {
    const file = await this.get(fileId);
    await this.require(caller, file.assetId, 'edit');
    if (file.status === 'ready') return toRecord(file);
    if (file.uploadedBy !== caller.principal.userId) throw AppError.forbidden('Only the uploader can complete this upload');
    const head = await this.storage.head(file.objectKey);
    if (!head) throw AppError.conflict('The upload has not reached storage yet');
    if (head.size !== file.size || (head.contentType && head.contentType !== file.contentType)) {
      await this.storage.delete([file.objectKey]);
      await this.files.delete(file.id);
      throw AppError.validation('The uploaded file does not match what was declared');
    }
    return toRecord(await this.files.markReady(file.id, head.etag));
  }

  /** Short-lived URL; previewable types open inline, everything else downloads. */
  async signedUrl(caller: Caller, fileId: string, mode: 'preview' | 'download'): Promise<SignedUrl> {
    const file = await this.get(fileId);
    await this.require(caller, file.assetId, 'view');
    if (file.status !== 'ready') throw AppError.conflict('The file is still uploading');
    const inline = mode === 'preview' && previewKindOf(file.contentType) !== 'none';
    const { url, expiresAt } = await this.storage.presignDownload(file.objectKey, {
      contentType: file.contentType,
      disposition: contentDisposition(file.filename, inline),
    });
    return { url, expiresAt: expiresAt.toISOString() };
  }

  async remove(caller: Caller, fileId: string): Promise<void> {
    const file = await this.get(fileId);
    const level = await this.require(caller, file.assetId, 'edit');
    if (file.uploadedBy !== caller.principal.userId && !atLeast(level, 'manage')) {
      throw AppError.forbidden('Only the uploader or a manager can delete this file');
    }
    await this.files.delete(file.id);
    await this.storage.delete([file.objectKey]);
  }

  /** The asset is gone, so are its documents. */
  async onAssetDeleted(assetId: string): Promise<void> {
    const removed = await this.files.deleteByAsset(assetId);
    if (removed.length) await this.storage.delete(removed.map((f) => f.objectKey));
  }

  /** Uploads that were requested but never completed. */
  async purgeAbandoned(olderThan: Date): Promise<number> {
    const stale = await this.files.stalePending(olderThan);
    if (!stale.length) return 0;
    await this.storage.delete(stale.map((f) => f.objectKey));
    for (const f of stale) await this.files.delete(f.id);
    return stale.length;
  }

  private async get(id: string) {
    const file = await this.files.get(id);
    if (!file) throw AppError.notFound('File');
    return file;
  }

  private async require(caller: Caller, assetId: string, level: AccessLevel): Promise<AccessLevel> {
    const check = await this.access.check(caller.token, assetId);
    if (!check) throw AppError.notFound('Asset');
    if (!atLeast(check.level, level)) throw AppError.forbidden();
    return check.level;
  }
}
