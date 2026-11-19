import { permissionsOfLevel, type Duration, type ObligationState, type TrackedDate } from '@am/core';
import { outboxMigration, type OutboxTable } from '@am/platform';
import { sql, type ColumnType, type Generated, type Migration } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T> = ColumnType<T, string, string>;

export interface SchedulerDB extends OutboxTable {
  assets_ref: {
    asset_id: string;
    name: string;
    asset_type_id: string;
    asset_type_name: string;
    unit_id: string;
    catalog_id: string | null;
    owner_id: string | null;
    active: boolean;
    deleted: Generated<boolean>;
    spend: Json<{ amount: number; currency: string } | null>;
    version: number;
  };
  units_ref: {
    id: string;
    name: string;
    parent_id: string | null;
    path: ColumnType<string[], string[], string[]>;
    archived: boolean;
    /** People who manage this unit; reminders fall back to the nearest unit that has some. */
    manager_ids: ColumnType<string[], string[], string[]>;
  };
  users_ref: {
    id: string;
    username: string;
    display_name: string;
    email: string | null;
    active: boolean;
    email_reminders: boolean;
    outlook_invites: boolean;
    calendar_token: string | null;
    group_ids: ColumnType<string[], string[] | undefined, string[]>;
  };
  obligations: {
    id: Generated<string>;
    asset_id: string;
    field_key: string;
    label: string;
    date_kind: Json<TrackedDate['dateKind']>;
    due_date: string;
    recurring: boolean;
    reminders: Json<Duration[]>;
    notify: Json<TrackedDate['notify']>;
    state: ObligationState;
    snoozed_until: string | null;
    sequence: Generated<number>;
    invites_synced_sequence: number | null;
    resolved_at: Timestamp | null;
    resolved_by: string | null;
    note: string | null;
    confirm_before: Json<Duration | null>;
    check_status: 'asked' | 'renew' | 'change' | 'cancel' | null;
    check_asked_at: Timestamp | null;
    check_asked_by: string | null;
    check_asked_by_name: string | null;
    check_message: string | null;
    check_answered_at: Timestamp | null;
    check_answered_by: string | null;
    check_answered_by_name: string | null;
    check_note: string | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  /** Projection of catalog sharing (owned by the registry). */
  catalogs_ref: { id: string; version: number; deleted: boolean };
  catalog_shares: { catalog_id: string; subject_key: string; permissions: ColumnType<string[], string[], string[]> };
  deliveries: {
    obligation_id: string;
    recipient: string;
    slot: string;
    sent_at: Timestamp;
  };
  invites: {
    obligation_id: string;
    recipient: string;
    sequence: number;
    cancelled: boolean;
    sent_at: Timestamp;
  };
}

export const migrations: Record<string, Migration> = {
  '0001_outbox': outboxMigration,
  '0002_scheduler': {
    async up(db) {
      await db.schema
        .createTable('assets_ref')
        .addColumn('asset_id', 'uuid', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('asset_type_id', 'uuid', (c) => c.notNull())
        .addColumn('asset_type_name', 'text', (c) => c.notNull())
        .addColumn('purchase_class_id', 'uuid', (c) => c.notNull())
        .addColumn('owner_id', 'uuid')
        .addColumn('active', 'boolean', (c) => c.notNull())
        .addColumn('deleted', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('spend', 'jsonb')
        .addColumn('version', 'integer', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('assets_ref_scope').on('assets_ref').columns(['purchase_class_id', 'asset_type_id']).execute();

      await db.schema
        .createTable('users_ref')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('username', 'text', (c) => c.notNull())
        .addColumn('display_name', 'text', (c) => c.notNull())
        .addColumn('email', 'text')
        .addColumn('active', 'boolean', (c) => c.notNull())
        .addColumn('email_reminders', 'boolean', (c) => c.notNull())
        .addColumn('outlook_invites', 'boolean', (c) => c.notNull())
        .addColumn('calendar_token', 'text', (c) => c.unique())
        .execute();

      await db.schema
        .createTable('obligations')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('asset_id', 'uuid', (c) => c.notNull().references('assets_ref.asset_id'))
        .addColumn('field_key', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())
        .addColumn('date_kind', 'jsonb', (c) => c.notNull())
        .addColumn('due_date', 'date', (c) => c.notNull())
        .addColumn('recurring', 'boolean', (c) => c.notNull())
        .addColumn('reminders', 'jsonb', (c) => c.notNull())
        .addColumn('notify', 'jsonb', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull().check(sql`state in ('open','snoozed','done','dismissed','superseded')`))
        .addColumn('snoozed_until', 'date')
        .addColumn('sequence', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('invites_synced_sequence', 'integer')
        .addColumn('resolved_at', 'timestamptz')
        .addColumn('resolved_by', 'uuid')
        .addColumn('note', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      // One active occurrence per (asset, date field) — the invariant reconcile() relies on.
      await sql`create unique index obligations_one_active on obligations (asset_id, field_key) where state in ('open','snoozed')`.execute(db);
      await sql`create index obligations_due on obligations (due_date) where state in ('open','snoozed')`.execute(db);
      await sql`create index obligations_invites on obligations (updated_at) where sequence is distinct from invites_synced_sequence`.execute(db);

      await db.schema
        .createTable('deliveries')
        .addColumn('obligation_id', 'uuid', (c) => c.notNull().references('obligations.id').onDelete('cascade'))
        .addColumn('recipient', 'text', (c) => c.notNull())
        .addColumn('slot', 'text', (c) => c.notNull())
        .addColumn('sent_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('deliveries_pk', ['obligation_id', 'recipient', 'slot'])
        .execute();

      await db.schema
        .createTable('invites')
        .addColumn('obligation_id', 'uuid', (c) => c.notNull().references('obligations.id').onDelete('cascade'))
        .addColumn('recipient', 'text', (c) => c.notNull())
        .addColumn('sequence', 'integer', (c) => c.notNull())
        .addColumn('cancelled', 'boolean', (c) => c.notNull())
        .addColumn('sent_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('invites_pk', ['obligation_id', 'recipient'])
        .execute();
    },
  },
  '0003_units': {
    async up(db) {
      await sql`alter table assets_ref rename column purchase_class_id to unit_id`.execute(db);
      await db.schema
        .createTable('units_ref')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('parent_id', 'uuid')
        .addColumn('path', sql`uuid[]`, (c) => c.notNull())
        .addColumn('archived', 'boolean', (c) => c.notNull())
        .addColumn('manager_ids', sql`uuid[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
        .execute();
      await sql`create index units_ref_path on units_ref using gin (path)`.execute(db);
    },
  },
  '0004_catalogs_renewal_checks': {
    async up(db) {
      await sql`alter table assets_ref add column catalog_id uuid`.execute(db);
      await db.schema.createIndex('assets_ref_catalog').on('assets_ref').column('catalog_id').execute();
      await db.schema
        .createTable('catalogs_ref')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('version', 'integer', (c) => c.notNull())
        .addColumn('deleted', 'boolean', (c) => c.notNull())
        .execute();
      await db.schema
        .createTable('catalog_shares')
        .addColumn('catalog_id', 'uuid', (c) => c.notNull())
        .addColumn('subject_key', 'text', (c) => c.notNull())
        .addColumn('level', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('catalog_shares_pk', ['catalog_id', 'subject_key'])
        .execute();
      await db.schema.createIndex('catalog_shares_subject').on('catalog_shares').columns(['subject_key', 'level']).execute();
      await sql`alter table obligations
        add column confirm_before jsonb,
        add column check_status text check (check_status in ('asked','renew','change','cancel')),
        add column check_asked_at timestamptz,
        add column check_asked_by uuid,
        add column check_asked_by_name text,
        add column check_message text,
        add column check_answered_at timestamptz,
        add column check_answered_by uuid,
        add column check_answered_by_name text,
        add column check_note text`.execute(db);
      await sql`create index obligations_check on obligations (check_status) where check_status is not null`.execute(db);
    },
  },
  '0005_roles': {
    async up(db) {
      await sql`alter table catalog_shares add column permissions text[]`.execute(db);
      for (const level of ['view', 'edit']) await sql`update catalog_shares set permissions = ${permissionsOfLevel(level)}::text[] where level = ${level}`.execute(db);
      await sql`alter table catalog_shares alter column permissions set not null, drop column level`.execute(db);
      await sql`create index if not exists catalog_shares_subject_only on catalog_shares (subject_key)`.execute(db);
      await sql`alter table users_ref add column group_ids uuid[] not null default '{}'`.execute(db);
    },
  },
};
