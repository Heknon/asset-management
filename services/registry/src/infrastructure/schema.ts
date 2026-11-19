import { defaultDateKinds, type AssetStatus, type Attributes, type DateBehavior, type Duration, type FieldDefinition, type RequestEvent, type RequestStatus, type SavedQuery } from '@am/core';
import { outboxMigration, trySavepoint, type OutboxTable } from '@am/platform';
import { sql, type ColumnType, type Generated, type Migration } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T> = ColumnType<T, string, string>;

export interface RegistryDB extends OutboxTable {
  date_kinds: {
    id: Generated<string>;
    key: string;
    name: string;
    description: string | null;
    color: string;
    behavior: DateBehavior;
    action_label: string;
    default_recurrence: Json<Duration | null>;
    default_reminders: Json<Duration[]>;
    archived: Generated<boolean>;
  };
  asset_types: {
    id: Generated<string>;
    key: string;
    name: string;
    description: string | null;
    icon: string;
    color: string;
    statuses: Json<AssetStatus[]>;
    sections: Json<string[]>;
    fields: Json<FieldDefinition[]>;
    version: number;
    archived: Generated<boolean>;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  assets: {
    id: Generated<string>;
    asset_type_id: string;
    type_version: number;
    name: string;
    status: string;
    owner_id: string | null;
    unit_id: string;
    /** Non-restricted values: searchable and visible to every viewer. */
    attributes: Json<Attributes>;
    /** Restricted values (secrets, sensitive fields): only returned to `manage`. */
    restricted_attributes: Json<Attributes>;
    reminder_overrides: Json<Record<string, Duration[]>>;
    version: number;
    /** Labelled text of every non-restricted value (display, for snippets). */
    search_text: Generated<string>;
    /** Accent-folded, lower-cased search_text: feeds the full-text vector and trigram index. */
    search_key: Generated<string>;
    created_by: string;
    updated_by: string;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  activity: {
    id: Generated<string>;
    asset_id: string;
    actor_id: string;
    actor_name: string;
    action: 'created' | 'updated' | 'deleted' | 'advanced';
    changes: Json<Record<string, { from: unknown; to: unknown }>>;
    at: Timestamp;
  };
  /** Projections of other contexts, maintained from events. */
  units_ref: {
    id: string;
    key: string;
    name: string;
    kind: string;
    parent_id: string | null;
    path: ColumnType<string[], string[], string[]>;
    archived: boolean;
  };
  users_ref: { id: string; display_name: string; active: boolean };
  requests: {
    id: Generated<string>;
    seq: Generated<number>;
    title: string;
    description: string;
    unit_id: string;
    asset_type_id: string | null;
    requester_id: string;
    requester_name: string;
    assignee_id: string | null;
    status: RequestStatus;
    quantity: number | null;
    estimated_amount: number | null;
    estimated_currency: string | null;
    needed_by: string | null;
    link: string | null;
    asset_id: string | null;
    search_text: string;
    search_key: string;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  request_events: {
    id: Generated<string>;
    request_id: string;
    actor_id: string;
    actor_name: string;
    kind: RequestEvent['kind'];
    body: string | null;
    from_status: RequestStatus | null;
    to_status: RequestStatus | null;
    at: Timestamp;
  };
  saved_views: {
    id: Generated<string>;
    owner_id: string;
    name: string;
    query: Json<SavedQuery>;
    pinned: boolean;
    created_at: Timestamp;
  };
}

export const migrations: Record<string, Migration> = {
  '0001_outbox': outboxMigration,
  '0002_registry': {
    async up(db) {
      await db.schema
        .createTable('date_kinds')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('key', 'text', (c) => c.notNull().unique())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('color', 'text', (c) => c.notNull())
        .addColumn('behavior', 'text', (c) => c.notNull().check(sql`behavior in ('milestone','recurring','informational')`))
        .addColumn('action_label', 'text', (c) => c.notNull())
        .addColumn('default_recurrence', 'jsonb')
        .addColumn('default_reminders', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
        .addColumn('archived', 'boolean', (c) => c.notNull().defaultTo(false))
        .execute();

      await db.schema
        .createTable('asset_types')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('key', 'text', (c) => c.notNull().unique())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('icon', 'text', (c) => c.notNull())
        .addColumn('color', 'text', (c) => c.notNull())
        .addColumn('statuses', 'jsonb', (c) => c.notNull())
        .addColumn('sections', 'jsonb', (c) => c.notNull())
        .addColumn('fields', 'jsonb', (c) => c.notNull())
        .addColumn('version', 'integer', (c) => c.notNull())
        .addColumn('archived', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();

      await db.schema
        .createTable('assets')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('asset_type_id', 'uuid', (c) => c.notNull().references('asset_types.id'))
        .addColumn('type_version', 'integer', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('owner_id', 'uuid')
        .addColumn('purchase_class_id', 'uuid', (c) => c.notNull())
        .addColumn('attributes', 'jsonb', (c) => c.notNull())
        .addColumn('restricted_attributes', 'jsonb', (c) => c.notNull())
        .addColumn('reminder_overrides', 'jsonb', (c) => c.notNull())
        .addColumn('version', 'integer', (c) => c.notNull())
        .addColumn('created_by', 'uuid', (c) => c.notNull())
        .addColumn('updated_by', 'uuid', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema.createIndex('assets_scope').on('assets').columns(['purchase_class_id', 'asset_type_id']).execute();
      await db.schema.createIndex('assets_type').on('assets').columns(['asset_type_id', 'updated_at']).execute();
      await sql`create index assets_attributes on assets using gin (attributes jsonb_path_ops)`.execute(db);

      await db.schema
        .createTable('activity')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('asset_id', 'uuid', (c) => c.notNull())
        .addColumn('actor_id', 'uuid', (c) => c.notNull())
        .addColumn('actor_name', 'text', (c) => c.notNull())
        .addColumn('action', 'text', (c) => c.notNull())
        .addColumn('changes', 'jsonb', (c) => c.notNull())
        .addColumn('at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema.createIndex('activity_asset').on('activity').columns(['asset_id', 'at']).execute();

      await db.schema
        .createTable('purchase_classes_ref')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('archived', 'boolean', (c) => c.notNull())
        .execute();
      await db.schema
        .createTable('users_ref')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('display_name', 'text', (c) => c.notNull())
        .addColumn('active', 'boolean', (c) => c.notNull())
        .execute();
    },
  },
  '0003_seed_date_kinds': {
    async up(db) {
      for (const k of defaultDateKinds) {
        await sql`insert into date_kinds (key, name, description, color, behavior, action_label, default_recurrence, default_reminders)
          values (${k.key}, ${k.name}, ${k.description ?? null}, ${k.color}, ${k.behavior}, ${k.actionLabel}, ${JSON.stringify(k.defaultRecurrence ?? null)}::jsonb, ${JSON.stringify(k.defaultReminders)}::jsonb)
          on conflict (key) do nothing`.execute(db);
      }
    },
  },
  '0004_units_search_requests': {
    async up(db) {
      // Purchase classes became organization units (a tree), owned by identity.
      await sql`alter table purchase_classes_ref rename to units_ref`.execute(db);
      await sql`alter table units_ref add column kind text not null default 'Team', add column parent_id uuid, add column path uuid[] not null default '{}'`.execute(db);
      await sql`update units_ref set path = array[id]`.execute(db);
      await sql`create index units_ref_path on units_ref using gin (path)`.execute(db);
      await sql`alter table assets rename column purchase_class_id to unit_id`.execute(db);

      // Search: labelled text → tsvector (prefix matching) + trigrams (typos, substrings).
      await sql`alter table assets add column search_text text not null default '', add column search_key text not null default ''`.execute(db);
      // search_key is accent-folded by the application, so "cafe" finds "Café".
      await sql`alter table assets add column search_vector tsvector generated always as (to_tsvector('simple', search_key)) stored`.execute(db);
      await sql`create index assets_search on assets using gin (search_vector)`.execute(db);
      // pg_trgm is a trusted extension (PG13+); without it search still works, just without fuzzy matching.
      if (await trySavepoint(db, 'trgm', () => sql`create extension if not exists pg_trgm`.execute(db))) {
        await sql`create index assets_search_trgm on assets using gin (search_key gin_trgm_ops)`.execute(db);
        await sql`create index assets_name_trgm on assets using gin (name gin_trgm_ops)`.execute(db);
      }

      await db.schema
        .createTable('requests')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('seq', 'bigserial', (c) => c.notNull().unique())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('description', 'text', (c) => c.notNull())
        .addColumn('unit_id', 'uuid', (c) => c.notNull())
        .addColumn('asset_type_id', 'uuid')
        .addColumn('requester_id', 'uuid', (c) => c.notNull())
        .addColumn('requester_name', 'text', (c) => c.notNull())
        .addColumn('assignee_id', 'uuid')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('quantity', 'integer')
        .addColumn('estimated_amount', sql`numeric(14,2)`)
        .addColumn('estimated_currency', 'text')
        .addColumn('needed_by', 'date')
        .addColumn('link', 'text')
        .addColumn('asset_id', 'uuid')
        .addColumn('search_text', 'text', (c) => c.notNull())
        .addColumn('search_key', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await sql`alter sequence requests_seq_seq restart with 1001`.execute(db);
      await sql`alter table requests add column search_vector tsvector generated always as (to_tsvector('simple', search_key)) stored`.execute(db);
      await sql`create index requests_search on requests using gin (search_vector)`.execute(db);
      if (await trySavepoint(db, 'trgm_requests', () => sql`select 'a' % 'a'`.execute(db))) {
        await sql`create index requests_search_trgm on requests using gin (search_key gin_trgm_ops)`.execute(db);
      }
      await db.schema.createIndex('requests_unit').on('requests').columns(['unit_id', 'status']).execute();
      await db.schema.createIndex('requests_requester').on('requests').columns(['requester_id', 'status']).execute();
      await db.schema.createIndex('requests_asset').on('requests').column('asset_id').execute();

      await db.schema
        .createTable('request_events')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('request_id', 'uuid', (c) => c.notNull().references('requests.id').onDelete('cascade'))
        .addColumn('actor_id', 'uuid', (c) => c.notNull())
        .addColumn('actor_name', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('body', 'text')
        .addColumn('from_status', 'text')
        .addColumn('to_status', 'text')
        .addColumn('at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema.createIndex('request_events_request').on('request_events').columns(['request_id', 'at']).execute();

      await db.schema
        .createTable('saved_views')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('owner_id', 'uuid', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('query', 'jsonb', (c) => c.notNull())
        .addColumn('pinned', 'boolean', (c) => c.notNull().defaultTo(true))
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema.createIndex('saved_views_owner').on('saved_views').column('owner_id').execute();
    },
  },
};
