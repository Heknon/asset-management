import { defaultRefPrefix, defaultWorkflow, permissionsOfLevel, type Permission, type StatusCategory, type Workflow } from '@am/core';
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
    ref_prefix: string;
    /** Own request workflow; null follows the organization's default. */
    request_workflow: Json<Workflow | null>;
    /** Last item number handed out ("LIC-42"). */
    ref_seq: Generated<number>;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  type_variants: {
    id: Generated<string>;
    asset_type_id: string;
    unit_id: string;
    name: string;
    description: string | null;
    sections: Json<string[]>;
    fields: Json<FieldDefinition[]>;
    version: Generated<number>;
    archived: Generated<boolean>;
    created_by_name: string;
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
    catalog_id: string | null;
    variant_id: string | null;
    ref_no: number;
    import_batch_id: string | null;
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
  users_ref: {
    id: string;
    display_name: string;
    username: string | null;
    email: string | null;
    other_names: ColumnType<string[], string[] | undefined, string[]>;
    active: boolean;
    group_ids: ColumnType<string[], string[] | undefined, string[]>;
  };
  groups_ref: { id: string; name: string; source: string; member_count: number };
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
    /** The status's category in its workflow (open = todo/active), kept with it so lists work for any workflow. */
    status_category: StatusCategory;
    kind: 'purchase' | 'renewal';
    renewal_asset_id: string | null;
    renewal_field_key: string | null;
    renewal_obligation_id: string | null;
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
  catalogs: {
    id: Generated<string>;
    unit_id: string;
    name: string;
    description: string | null;
    icon: string;
    color: string;
    version: Generated<number>;
    created_by: string;
    created_by_name: string;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  /** "unit:<id>" reaches that unit and everything beneath it; "user:<id>" one person. */
  catalog_shares: {
    catalog_id: string;
    subject_key: string;
    permissions: ColumnType<Permission[], Permission[], Permission[]>;
    created_by_name: string;
    created_at: Timestamp;
  };
  asset_comments: {
    id: Generated<string>;
    asset_id: string;
    kind: Generated<'message' | 'renewal_check'>;
    /** Idempotency key for messages posted from events. */
    source_key: string | null;
    author_id: string;
    author_name: string;
    body: string;
    mention_ids: ColumnType<string[], string[], string[]>;
    created_at: Timestamp;
    edited_at: Timestamp | null;
    deleted: Generated<boolean>;
  };
  import_batches: {
    id: Generated<string>;
    asset_type_id: string;
    file_name: string;
    created_by: string;
    created_by_name: string;
    created_count: Generated<number>;
    updated_count: Generated<number>;
    created_at: Timestamp;
    undone_at: Timestamp | null;
  };
  settings: { key: string; value: Json<unknown>; updated_at: Timestamp };
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
  '0005_catalogs_comments': {
    async up(db) {
      await db.schema
        .createTable('catalogs')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('unit_id', 'uuid', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('icon', 'text', (c) => c.notNull())
        .addColumn('color', 'text', (c) => c.notNull())
        .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
        .addColumn('created_by', 'uuid', (c) => c.notNull())
        .addColumn('created_by_name', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema.createIndex('catalogs_unit').on('catalogs').column('unit_id').execute();
      await sql`create unique index catalogs_unit_name on catalogs (unit_id, lower(name))`.execute(db);

      await db.schema
        .createTable('catalog_shares')
        .addColumn('catalog_id', 'uuid', (c) => c.notNull().references('catalogs.id').onDelete('cascade'))
        .addColumn('subject_key', 'text', (c) => c.notNull())
        .addColumn('level', 'text', (c) => c.notNull().check(sql`level in ('view','edit')`))
        .addColumn('created_by_name', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('catalog_shares_pk', ['catalog_id', 'subject_key'])
        .execute();
      await db.schema.createIndex('catalog_shares_subject').on('catalog_shares').columns(['subject_key', 'level']).execute();

      await sql`alter table assets add column catalog_id uuid references catalogs(id)`.execute(db);
      await db.schema.createIndex('assets_catalog').on('assets').column('catalog_id').execute();

      await db.schema
        .createTable('asset_comments')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('asset_id', 'uuid', (c) => c.notNull().references('assets.id').onDelete('cascade'))
        .addColumn('kind', 'text', (c) => c.notNull().defaultTo('message'))
        .addColumn('source_key', 'text', (c) => c.unique())
        .addColumn('author_id', 'uuid', (c) => c.notNull())
        .addColumn('author_name', 'text', (c) => c.notNull())
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('mention_ids', sql`uuid[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('edited_at', 'timestamptz')
        .addColumn('deleted', 'boolean', (c) => c.notNull().defaultTo(false))
        .execute();
      await db.schema.createIndex('asset_comments_asset').on('asset_comments').columns(['asset_id', 'created_at']).execute();
    },
  },
  '0006_roles': {
    async up(db) {
      // Share levels become permission sets; catalogs can be shared with directory groups.
      await sql`alter table catalog_shares add column permissions text[]`.execute(db);
      for (const level of ['view', 'edit']) await sql`update catalog_shares set permissions = ${permissionsOfLevel(level)}::text[] where level = ${level}`.execute(db);
      await sql`alter table catalog_shares alter column permissions set not null, drop column level`.execute(db);
      await sql`create index if not exists catalog_shares_subject_only on catalog_shares (subject_key)`.execute(db);
      await sql`alter table users_ref add column group_ids uuid[] not null default '{}'`.execute(db);
      await db.schema
        .createTable('groups_ref')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('member_count', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
    },
  },
  '0007_variants_references': {
    async up(db) {
      // Item IDs: PREFIX-number per template ("LIC-42"), numbered in creation order.
      await sql`alter table asset_types add column ref_prefix text, add column ref_seq integer not null default 0`.execute(db);
      const known: Record<string, string> = { software_license: 'LIC', sim_line: 'SIM', hardware: 'HW', domain_certificate: 'DOM' };
      for (const t of (await sql<{ id: string; key: string }>`select id, key from asset_types`.execute(db)).rows) {
        await sql`update asset_types set ref_prefix = ${known[t.key] ?? defaultRefPrefix(t.key)} where id = ${t.id}`.execute(db);
      }
      await sql`alter table asset_types alter column ref_prefix set not null`.execute(db);
      await sql`alter table assets add column ref_no integer`.execute(db);
      await sql`update assets a set ref_no = n.rn from (select id, row_number() over (partition by asset_type_id order by created_at, id) as rn from assets) n where n.id = a.id`.execute(db);
      await sql`update asset_types t set ref_seq = coalesce((select max(ref_no) from assets a where a.asset_type_id = t.id), 0)`.execute(db);
      await sql`alter table assets alter column ref_no set not null`.execute(db);
      await sql`create unique index assets_reference on assets (asset_type_id, ref_no)`.execute(db);

      // Team variants: a unit's extension of a template.
      await db.schema
        .createTable('type_variants')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('asset_type_id', 'uuid', (c) => c.notNull().references('asset_types.id'))
        .addColumn('unit_id', 'uuid', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('sections', 'jsonb', (c) => c.notNull())
        .addColumn('fields', 'jsonb', (c) => c.notNull())
        .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
        .addColumn('archived', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('created_by_name', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await sql`create unique index type_variants_name on type_variants (asset_type_id, unit_id, lower(name))`.execute(db);
      await sql`alter table assets add column variant_id uuid references type_variants(id)`.execute(db);
      await db.schema.createIndex('assets_variant').on('assets').column('variant_id').execute();
      // Search text now includes the item ID: rebuild it in the background.
      await sql`update assets set search_text = ''`.execute(db);
    },
  },
  '0008_imports': {
    async up(db) {
      await db.schema
        .createTable('import_batches')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('asset_type_id', 'uuid', (c) => c.notNull())
        .addColumn('file_name', 'text', (c) => c.notNull())
        .addColumn('created_by', 'uuid', (c) => c.notNull())
        .addColumn('created_by_name', 'text', (c) => c.notNull())
        .addColumn('created_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('updated_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('undone_at', 'timestamptz')
        .execute();
      await db.schema.createIndex('import_batches_creator').on('import_batches').columns(['created_by', 'created_at']).execute();
      await sql`alter table assets add column import_batch_id uuid references import_batches(id)`.execute(db);
      await db.schema.createIndex('assets_import_batch').on('assets').column('import_batch_id').execute();
    },
  },
  '0009_workflows_renewals': {
    async up(db) {
      await sql`alter table asset_types add column request_workflow jsonb`.execute(db);
      await db.schema
        .createTable('settings')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'jsonb', (c) => c.notNull())
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await sql`alter table requests
        add column status_category text not null default 'todo',
        add column kind text not null default 'purchase',
        add column renewal_asset_id uuid,
        add column renewal_field_key text,
        add column renewal_obligation_id uuid`.execute(db);
      for (const st of defaultWorkflow.statuses) {
        await sql`update requests set status_category = ${st.category} where status = ${st.key}`.execute(db);
      }
      await sql`create index requests_category on requests (status_category, unit_id)`.execute(db);
      await sql`create index requests_renewal on requests (renewal_asset_id, renewal_field_key) where kind = 'renewal'`.execute(db);
      // One open renewal request per date occurrence.
      await sql`create unique index requests_open_renewal on requests (renewal_obligation_id) where renewal_obligation_id is not null and status_category in ('todo','active')`.execute(db);
    },
  },
  '0010_people_search_names': {
    async up(db) {
      // Asset search finds an owner or person field by any of these, not only the display name.
      await sql`alter table users_ref add column username text, add column email text, add column other_names text[] not null default '{}'`.execute(db);
    },
  },
};
