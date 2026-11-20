import { AppError } from '@am/core';
import { outboxMigration, type OutboxTable } from '@am/platform';
import { sql, type ColumnType, type Kysely, type Migration, type Selectable } from 'kysely';
import type { FileStore } from '../application/ports.js';
import type { StoredFile } from '../domain/file.js';

export interface FilesDB extends OutboxTable {
  files: {
    id: string;
    asset_id: string;
    object_key: string;
    filename: string;
    content_type: string;
    size: number;
    status: 'pending' | 'ready';
    etag: string | null;
    uploaded_by: string;
    uploaded_by_name: string;
    created_at: ColumnType<Date, Date | undefined, never>;
  };
}

export const migrations: Record<string, Migration> = {
  '0001_outbox': outboxMigration,
  '0002_files': {
    async up(db) {
      await db.schema
        .createTable('files')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('asset_id', 'uuid', (c) => c.notNull())
        .addColumn('object_key', 'text', (c) => c.notNull().unique())
        .addColumn('filename', 'text', (c) => c.notNull())
        .addColumn('content_type', 'text', (c) => c.notNull())
        .addColumn('size', 'bigint', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull().check(sql`status in ('pending','ready')`))
        .addColumn('etag', 'text')
        .addColumn('uploaded_by', 'uuid', (c) => c.notNull())
        .addColumn('uploaded_by_name', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema.createIndex('files_asset').on('files').columns(['asset_id', 'created_at']).execute();
    },
  },
};

const toFile = (r: Selectable<FilesDB['files']>): StoredFile => ({
  id: r.id,
  assetId: r.asset_id,
  objectKey: r.object_key,
  filename: r.filename,
  contentType: r.content_type,
  size: Number(r.size),
  status: r.status,
  etag: r.etag,
  uploadedBy: r.uploaded_by,
  uploadedByName: r.uploaded_by_name,
  createdAt: r.created_at,
});

export class PgFileStore implements FileStore {
  constructor(private readonly db: Kysely<FilesDB>) {}

  async insert(f: Omit<StoredFile, 'createdAt'>) {
    const r = await this.db
      .insertInto('files')
      .values({
        id: f.id,
        asset_id: f.assetId,
        object_key: f.objectKey,
        filename: f.filename,
        content_type: f.contentType,
        size: f.size,
        status: f.status,
        etag: f.etag,
        uploaded_by: f.uploadedBy,
        uploaded_by_name: f.uploadedByName,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toFile(r);
  }

  async get(id: string) {
    const r = await this.db.selectFrom('files').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toFile(r) : null;
  }

  async listByAsset(assetId: string) {
    return (await this.db.selectFrom('files').selectAll().where('asset_id', '=', assetId).orderBy('created_at', 'desc').execute()).map(toFile);
  }

  async markReady(id: string, etag: string | null) {
    const r = await this.db.updateTable('files').set({ status: 'ready', etag }).where('id', '=', id).returningAll().executeTakeFirst();
    if (!r) throw AppError.notFound('File');
    return toFile(r);
  }

  async delete(id: string) {
    await this.db.deleteFrom('files').where('id', '=', id).execute();
  }

  async deleteByAsset(assetId: string) {
    return (await this.db.deleteFrom('files').where('asset_id', '=', assetId).returningAll().execute()).map(toFile);
  }

  async stalePending(olderThan: Date) {
    return (await this.db.selectFrom('files').selectAll().where('status', '=', 'pending').where('created_at', '<', olderThan).limit(500).execute()).map(toFile);
  }
}
