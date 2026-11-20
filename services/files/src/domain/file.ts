import { AppError, isAllowedContentType, previewKindOf, sanitizeFilename, type FileRecord } from '@am/core';

export interface StoredFile {
  id: string;
  assetId: string;
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  status: 'pending' | 'ready';
  etag: string | null;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: Date;
}

/** Keys are opaque ids; the user-supplied filename never becomes part of the object key. */
export function objectKeyFor(assetId: string, fileId: string): string {
  return `assets/${assetId}/${fileId}`;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OBJECT_KEY = new RegExp(`^assets/${UUID}/${UUID}$`, 'i');
/** Whether a key has the shape `objectKeyFor` produces (a restore may only write such keys). */
export const isObjectKey = (key: string) => OBJECT_KEY.test(key);

export function validateUpload(input: { filename: string; contentType: string; size: number }, maxBytes: number) {
  const contentType = input.contentType.toLowerCase().split(';')[0]!.trim();
  if (!isAllowedContentType(contentType)) throw AppError.validation(`Files of type ${contentType} are not allowed`);
  if (input.size > maxBytes) throw AppError.validation(`Files must be smaller than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  return { filename: sanitizeFilename(input.filename), contentType };
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename. */
export function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function toRecord(f: StoredFile): FileRecord {
  return {
    id: f.id,
    assetId: f.assetId,
    filename: f.filename,
    contentType: f.contentType,
    size: f.size,
    status: f.status,
    preview: previewKindOf(f.contentType),
    uploadedBy: f.uploadedBy,
    uploadedByName: f.uploadedByName,
    createdAt: f.createdAt.toISOString(),
  };
}
