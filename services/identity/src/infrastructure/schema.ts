import type { AuthSource, Preferences } from '@am/core';
import type { OutboxTable } from '@am/platform';
import { sql, type ColumnType, type Generated, type Migration } from 'kysely';
import { outboxMigration } from '@am/platform';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface IdentityDB extends OutboxTable {
  users: {
    id: Generated<string>;
    username: string;
    display_name: string;
    email: string | null;
    source: AuthSource;
    external_id: string | null;
    password_hash: string | null;
    is_admin: Generated<boolean>;
    directory_admin: Generated<boolean>;
    active: Generated<boolean>;
    preferences: ColumnType<Preferences, string, string>;
    /** Directory attribute values used for unit membership, e.g. `department=platform`. */
    directory_tags: ColumnType<string[], string[] | undefined, string[]>;
    last_login_at: Date | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  groups: {
    id: Generated<string>;
    name: string;
    external_id: string | null;
    source: AuthSource;
    created_at: Timestamp;
  };
  group_members: { group_id: string; user_id: string };
  org_units: {
    id: Generated<string>;
    key: string;
    name: string;
    kind: string;
    description: string | null;
    parent_id: string | null;
    /** Ancestor ids, root first, including the unit itself. */
    path: ColumnType<string[], string[] | undefined, string[]>;
    color: string;
    member_access: 'none' | 'view' | 'edit';
    directory_members: ColumnType<string[], string[] | undefined, string[]>;
    directory_managers: ColumnType<string[], string[] | undefined, string[]>;
    archived: Generated<boolean>;
    created_at: Timestamp;
  };
  unit_people: {
    unit_id: string;
    user_id: string;
    role: 'member' | 'manager';
    source: 'manual' | 'directory';
  };
  grants: {
    id: Generated<string>;
    principal_type: 'user' | 'group';
    principal_id: string;
    unit_id: string | null;
    asset_type_id: string | null;
    level: 'view' | 'edit' | 'manage';
    created_at: Timestamp;
  };
  sessions: {
    id: Generated<string>;
    user_id: string;
    token_hash: string;
    user_agent: string | null;
    expires_at: Timestamp;
    created_at: Timestamp;
    last_used_at: Timestamp;
    revoked_at: Timestamp | null;
  };
}

export const migrations: Record<string, Migration> = {
  '0001_outbox': outboxMigration,
  '0002_identity': {
    async up(db) {
      await db.schema
        .createTable('users')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('username', 'text', (c) => c.notNull())
        .addColumn('display_name', 'text', (c) => c.notNull())
        .addColumn('email', 'text')
        .addColumn('source', 'text', (c) => c.notNull().check(sql`source in ('local','ldap','oidc')`))
        .addColumn('external_id', 'text')
        .addColumn('password_hash', 'text')
        .addColumn('is_admin', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('directory_admin', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('active', 'boolean', (c) => c.notNull().defaultTo(true))
        .addColumn('preferences', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
        .addColumn('last_login_at', 'timestamptz')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await sql`create unique index users_source_username on users (source, lower(username))`.execute(db);
      await sql`create unique index users_source_external on users (source, external_id) where external_id is not null`.execute(db);
      await sql`create index users_search on users using gin (to_tsvector('simple', username || ' ' || display_name || ' ' || coalesce(email, '')))`.execute(db);

      await db.schema
        .createTable('groups')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('external_id', 'text')
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await sql`create unique index groups_external on groups (lower(external_id)) where external_id is not null`.execute(db);

      await db.schema
        .createTable('group_members')
        .addColumn('group_id', 'uuid', (c) => c.notNull().references('groups.id').onDelete('cascade'))
        .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addPrimaryKeyConstraint('group_members_pk', ['group_id', 'user_id'])
        .execute();
      await db.schema.createIndex('group_members_user').on('group_members').column('user_id').execute();

      await db.schema
        .createTable('purchase_classes')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('key', 'text', (c) => c.notNull().unique())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('color', 'text', (c) => c.notNull())
        .addColumn('archived', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();

      await db.schema
        .createTable('grants')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('principal_type', 'text', (c) => c.notNull().check(sql`principal_type in ('user','group')`))
        .addColumn('principal_id', 'uuid', (c) => c.notNull())
        .addColumn('purchase_class_id', 'uuid', (c) => c.references('purchase_classes.id').onDelete('cascade'))
        .addColumn('asset_type_id', 'uuid')
        .addColumn('level', 'text', (c) => c.notNull().check(sql`level in ('view','edit','manage')`))
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await sql`create unique index grants_unique on grants (principal_type, principal_id, coalesce(purchase_class_id, '00000000-0000-0000-0000-000000000000'), coalesce(asset_type_id, '00000000-0000-0000-0000-000000000000'))`.execute(db);

      await db.schema
        .createTable('sessions')
        .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
        .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('token_hash', 'text', (c) => c.notNull().unique())
        .addColumn('user_agent', 'text')
        .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('last_used_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('revoked_at', 'timestamptz')
        .execute();
      await db.schema.createIndex('sessions_user').on('sessions').column('user_id').execute();
    },
  },
  '0003_org_units': {
    async up(db) {
      // Purchase classes become organization units: a tree with directory-synced people.
      await sql`alter table purchase_classes rename to org_units`.execute(db);
      await sql`alter table org_units
        add column kind text not null default 'Team',
        add column parent_id uuid references org_units(id),
        add column path uuid[] not null default '{}',
        add column member_access text not null default 'view' check (member_access in ('none','view','edit')),
        add column directory_members text[] not null default '{}',
        add column directory_managers text[] not null default '{}'`.execute(db);
      await sql`update org_units set path = array[id]`.execute(db);
      await sql`create index org_units_parent on org_units (parent_id)`.execute(db);
      await sql`create index org_units_path on org_units using gin (path)`.execute(db);
      await sql`create index org_units_name on org_units (lower(name))`.execute(db);
      await sql`alter table grants rename column purchase_class_id to unit_id`.execute(db);
      await sql`alter table users add column directory_tags text[] not null default '{}'`.execute(db);
      await db.schema
        .createTable('unit_people')
        .addColumn('unit_id', 'uuid', (c) => c.notNull().references('org_units.id').onDelete('cascade'))
        .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('role', 'text', (c) => c.notNull().check(sql`role in ('member','manager')`))
        .addColumn('source', 'text', (c) => c.notNull().check(sql`source in ('manual','directory')`))
        .addPrimaryKeyConstraint('unit_people_pk', ['unit_id', 'user_id', 'role', 'source'])
        .execute();
      await db.schema.createIndex('unit_people_user').on('unit_people').column('user_id').execute();
    },
  },
};
