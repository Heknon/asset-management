import { defaultDateKinds, type AssetStatus, type Attributes, type DateBehavior, type Duration, type FieldDefinition } from '@am/core';
import { outboxMigration, type OutboxTable } from '@am/platform';
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
    purchase_class_id: string;
    /** Non-restricted values: searchable and visible to every viewer. */
    attributes: Json<Attributes>;
    /** Restricted values (secrets, sensitive fields): only returned to `manage`. */
    restricted_attributes: Json<Attributes>;
    reminder_overrides: Json<Record<string, Duration[]>>;
    version: number;
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
  purchase_classes_ref: { id: string; key: string; name: string; archived: boolean };
  users_ref: { id: string; display_name: string; active: boolean };
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
};
