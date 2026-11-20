import { allowedContentTypes, type FileRecord, type SignedUrl, type UploadTicket } from '@am/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileAudio, FileImage, FileText, FileVideo, File as FileIcon, Trash2, UploadCloud } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { keys, useFiles } from '@/lib/queries';
import { cn, formatBytes, formatDateTime } from '@/lib/utils';
import { Button } from './ui/button';
import { EmptyState, Spinner } from './ui/display';
import { Sheet } from './ui/overlay';

const previewIcons = { image: FileImage, pdf: FileText, text: FileText, video: FileVideo, audio: FileAudio, none: FileIcon };

/** Upload = ask for a presigned POST policy → send bytes straight to S3 → confirm. */
async function uploadFile(assetId: string, file: File): Promise<FileRecord> {
  const contentType = file.type || 'application/octet-stream';
  const ticket = await api.post<UploadTicket>('/api/files/uploads', { assetId, filename: file.name, contentType, size: file.size });
  const form = new FormData();
  Object.entries(ticket.upload.fields).forEach(([k, v]) => form.append(k, v));
  form.append('file', file); // must be the last field for S3
  const res = await fetch(ticket.upload.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Storage rejected the upload (${res.status})`);
  return api.post<FileRecord>(`/api/files/${ticket.file.id}/complete`);
}

const signedUrl = (id: string, mode: 'preview' | 'download') => api.get<SignedUrl>(`/api/files/${id}/url`, { mode });

export function Documents({ assetId, canEdit, canManage, currentUserId }: { assetId: string; canEdit: boolean; canManage: boolean; currentUserId: string }) {
  const files = useFiles(assetId);
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<FileRecord | null>(null);

  const upload = useMutation({
    mutationFn: async (list: File[]) => {
      for (const f of list) await uploadFile(assetId, f);
    },
    onSuccess: (_d, list) => toast.success(list.length === 1 ? `Uploaded ${list[0]!.name}` : `Uploaded ${list.length} files`),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Upload failed'),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.files(assetId) }),
  });
  const remove = useMutation({
    mutationFn: (f: FileRecord) => api.delete(`/api/files/${f.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.files(assetId) }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Delete failed'),
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (canEdit && e.dataTransfer.files.length) upload.mutate([...e.dataTransfer.files]);
  };
  const download = async (f: FileRecord) => {
    const { url } = await signedUrl(f.id, 'download');
    window.location.assign(url);
  };

  return (
    <div
      onDragOver={(e) => (e.preventDefault(), canEdit && setDragging(true))}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn('rounded-xl border border-border bg-surface transition-colors', dragging && 'border-accent bg-accent-soft/40')}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-[13px] font-semibold">Documents</h2>
        {canEdit && (
          <>
            <input ref={input} type="file" multiple hidden accept={allowedContentTypes.join(',')} onChange={(e) => e.target.files && upload.mutate([...e.target.files])} />
            <Button size="sm" icon={<UploadCloud className="size-3.5" />} loading={upload.isPending} onClick={() => input.current?.click()}>
              Upload
            </Button>
          </>
        )}
      </div>
      {files.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : !files.data?.length ? (
        <EmptyState icon={<UploadCloud />} title="No documents" description={canEdit ? 'Drop contracts, invoices or order forms here.' : 'Nothing has been attached yet.'} />
      ) : (
        <ul className="divide-y divide-border">
          {files.data.map((f) => {
            const Icon = previewIcons[f.preview];
            return (
              <li key={f.id} className="group flex items-center gap-3 px-4 py-2.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-muted">
                  <Icon className="size-4" />
                </span>
                <button type="button" className="min-w-0 flex-1 text-start" onClick={() => (f.preview === 'none' ? void download(f) : setPreview(f))}>
                  <div className="truncate text-[13px] font-medium hover:underline">{f.filename}</div>
                  <div className="text-xs text-muted">
                    {formatBytes(f.size)} · {f.uploadedByName} · {formatDateTime(f.createdAt)}
                  </div>
                </button>
                <div className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100">
                  <Button size="icon" variant="ghost" aria-label="Download" icon={<Download className="size-4" />} onClick={() => void download(f)} />
                  {(canManage || (canEdit && f.uploadedBy === currentUserId)) && (
                    <Button size="icon" variant="danger-ghost" aria-label="Delete" icon={<Trash2 className="size-4" />} onClick={() => remove.mutate(f)} />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <FilePreview file={preview} onClose={() => setPreview(null)} onDownload={download} />
    </div>
  );
}

/** In-app preview against a short-lived, inline presigned URL. */
function FilePreview({ file, onClose, onDownload }: { file: FileRecord | null; onClose: () => void; onDownload: (f: FileRecord) => void }) {
  const url = useQuery({ queryKey: ['file-url', file?.id], queryFn: () => signedUrl(file!.id, 'preview'), enabled: !!file, staleTime: 60_000, gcTime: 0 });
  const text = useQuery({
    queryKey: ['file-text', file?.id],
    queryFn: async () => (await fetch(url.data!.url)).text(),
    enabled: file?.preview === 'text' && !!url.data,
    gcTime: 0,
  });
  return (
    <Sheet
      open={!!file}
      onOpenChange={(o) => !o && onClose()}
      title={file?.filename ?? ''}
      description={file ? `${formatBytes(file.size)} · ${file.contentType}` : undefined}
      className="max-w-4xl"
      footer={file && <Button icon={<Download className="size-3.5" />} onClick={() => onDownload(file)}>Download</Button>}
    >
      {!url.data ? (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      ) : file?.preview === 'image' ? (
        <img src={url.data.url} alt={file.filename} className="mx-auto max-h-full rounded-lg object-contain" />
      ) : file?.preview === 'pdf' ? (
        <iframe title={file.filename} src={url.data.url} className="h-full min-h-[70vh] w-full rounded-lg border border-border" />
      ) : file?.preview === 'video' ? (
        <video src={url.data.url} controls className="w-full rounded-lg" />
      ) : file?.preview === 'audio' ? (
        <audio src={url.data.url} controls className="w-full" />
      ) : file?.preview === 'text' ? (
        <pre className="overflow-auto rounded-lg bg-surface-2 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">{text.data ?? 'Loading…'}</pre>
      ) : null}
    </Sheet>
  );
}
