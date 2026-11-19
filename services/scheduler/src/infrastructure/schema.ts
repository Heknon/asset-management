import type { Duration, ObligationState, TrackedDate } from '@am/core';
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
    created_at: Timestamp;
    updated_at: Timestamp;
  };
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
};
