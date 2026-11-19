import type { PreviewKind } from './api.js';

/** Content types accepted for upload, with how the UI previews them. */
const ALLOWED: Record<string, PreviewKind> = {
  'application/pdf': 'pdf',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'text/plain': 'text',
  'text/csv': 'text',
  'application/json': 'text',
  'video/mp4': 'video',
  'audio/mpeg': 'audio',
  'application/msword': 'none',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'none',
  'application/vnd.ms-excel': 'none',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'none',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'none',
  'application/zip': 'none',
  'message/rfc822': 'none',
};

export function isAllowedContentType(contentType: string): boolean {
  return contentType in ALLOWED;
}

export function previewKindOf(contentType: string): PreviewKind {
  return ALLOWED[contentType] ?? 'none';
}

export const allowedContentTypes = Object.keys(ALLOWED);

/** Strips path components and characters that are unsafe in headers/object keys. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim();
  return (clean || 'file').slice(0, 255);
}
