import { AppError, consolidateGrants, normalizePermissions, roles, type AuthSource, type Grant, type GrantInput, type GrantRecord, type Group, type OrgUnit, type OrgUnitInput, type Page, type Permission, type Subject, type SubjectKind, type UnitPerson, type UnitRole, type User, type UserSummary } from '@am/core';
import { enqueue } from '@am/platform';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { IdentityStore } from '../application/ports.js';
import { defaultPreferences, isAdministrator, type ExternalIdentity, type Session, type UserRecord } from '../domain/model.js';
import type { IdentityDB } from './schema.js';

type UserRow = Selectable<IdentityDB['users']>;

const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  email: r.email,
  source: r.source,
  externalId: r.external_id,
  isAdmin: r.is_admin,
  directoryAdmin: r.directory_admin,
  active: r.active,
  preferences: { ...defaultPreferences, ...(r.preferences ?? {}) },
  lastLoginAt: r.last_login_at,
});

type UnitRow = Selectable<IdentityDB['org_units']> & { members?: number | string | null; managers?: number | string | null };

const toUnit = (r: UnitRow): OrgUnit => ({
  id: r.id,
  key: r.key,
  name: r.name,
  kind: r.kind,
  description: r.description,
  parentId: r.parent_id,
  path: r.path,
  color: r.color,
  memberRole: r.member_role,
  directoryMembers: r.directory_members,
  directoryManagers: r.directory_managers,
  archived: r.archived,
  memberCount: Number(r.members ?? 0),
  managerCount: Number(r.managers ?? 0),
});

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505';

export class PgIdentityStore implements IdentityStore {
  constructor(private readonly db: Kysely<IdentityDB>) {}

  transaction<T>(fn: (store: IdentityStore) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return fn(this);
    return this.db.transaction().execute((trx) => fn(new PgIdentityStore(trx)));
  }

  // ─── Users ───────────────────────────────────────────────────────────────

  async findUserById(id: string) {
    const r = await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toUser(r) : null;
  }

  async findUserByUsername(username: string, source: AuthSource) {
    const r = await this.db.selectFrom('users').selectAll().where('source', '=', source).where(sql`lower(username)`, '=', username.toLowerCase()).executeTakeFirst();
    return r ? toUser(r) : null;
  }

  async findUserByExternalId(source: AuthSource, externalId: string) {
    const r = await this.db.selectFrom('users').selectAll().where('source', '=', source).where('external_id', '=', externalId).executeTakeFirst();
    return r ? toUser(r) : null;
  }

  async getPasswordHash(userId: string) {
    const r = await this.db.selectFrom('users').select('password_hash').where('id', '=', userId).executeTakeFirst();
    return r?.password_hash ?? null;
  }

  /** Just-in-time provisioning: directory attributes are refreshed on every login. */
  async upsertUserFromIdentity(identity: ExternalIdentity) {
    const existing =
      (await this.findUserByExternalId(identity.source, identity.externalId)) ?? (await this.findUserByUsername(identity.username, identity.source));
    if (existing) {
      const r = await this.db
        .updateTable('users')
        .set({
          username: identity.username,
          display_name: identity.displayName,
          email: identity.email,
          external_id: identity.externalId,
          ...(identity.source === 'local' ? {} : { directory_admin: identity.directoryAdmin, directory_tags: identity.tags }),
          updated_at: sql`now()`,
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toUser(r);
    }
    const r = await this.db
      .insertInto('users')
      .values({
        username: identity.username,
        display_name: identity.displayName,
        email: identity.email,
        source: identity.source,
        external_id: identity.externalId,
        password_hash: null,
        directory_admin: identity.directoryAdmin,
        directory_tags: identity.tags,
        preferences: JSON.stringify(defaultPreferences),
        last_login_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toUser(r);
  }

  async createLocalUser(input: { username: string; displayName: string; email: string | null; passwordHash: string; isAdmin: boolean }) {
    const r = await this.db
      .insertInto('users')
      .values({
        username: input.username,
        display_name: input.displayName,
        email: input.email,
        source: 'local',
        external_id: input.username,
        password_hash: input.passwordHash,
        is_admin: input.isAdmin,
        preferences: JSON.stringify(defaultPreferences),
        last_login_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toUser(r);
  }

  async setPasswordHash(userId: string, hash: string) {
    await this.db.updateTable('users').set({ password_hash: hash }).where('id', '=', userId).execute();
  }

  async updateUser(id: string, patch: Partial<Pick<UserRecord, 'isAdmin' | 'active' | 'preferences'>>) {
    const r = await this.db
      .updateTable('users')
      .set({
        ...(patch.isAdmin !== undefined && { is_admin: patch.isAdmin }),
        ...(patch.active !== undefined && { active: patch.active }),
        ...(patch.preferences && { preferences: JSON.stringify(patch.preferences) }),
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!r) throw AppError.notFound('User');
    return toUser(r);
  }

  async touchLogin(id: string) {
    await this.db.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', id).execute();
  }

  private userFilter(q?: string, ids?: string[]) {
    let query = this.db.selectFrom('users');
    if (ids?.length) query = query.where('id', 'in', ids);
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
      query = query.where((eb) => eb.or([eb('username', 'ilike', like), eb('display_name', 'ilike', like), eb('email', 'ilike', like)]));
    }
    return query;
  }

  async listUsers({ q, ids, limit, offset }: { q?: string; ids?: string[]; limit: number; offset: number }): Promise<Page<User>> {
    const base = this.userFilter(q, ids);
    const [rows, count] = await Promise.all([
      base.selectAll().orderBy('display_name').limit(limit).offset(offset).execute(),
      base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    const memberships = rows.length
      ? await this.db
          .selectFrom('group_members')
          .innerJoin('groups', 'groups.id', 'group_members.group_id')
          .select(['group_members.user_id', 'groups.id', 'groups.name'])
          .where('group_members.user_id', 'in', rows.map((r) => r.id))
          .execute()
      : [];
    const items = rows.map((r): User => {
      const u = toUser(r);
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        source: u.source,
        isAdmin: isAdministrator(u),
        active: u.active,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        groups: memberships.filter((m) => m.user_id === u.id).map((m) => ({ id: m.id, name: m.name })),
      };
    });
    return { items, total: Number(count.n), limit, offset };
  }

  async searchUserSummaries(q: string | undefined, ids: string[] | undefined, limit: number): Promise<UserSummary[]> {
    const rows = await this.userFilter(q, ids)
      .select(['id', 'username', 'display_name', 'email'])
      .where('active', '=', true)
      .orderBy('display_name')
      .limit(ids?.length ? Math.max(ids.length, limit) : limit)
      .execute();
    return rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, email: r.email }));
  }

  // ─── Groups ──────────────────────────────────────────────────────────────

  /** Replaces a user's memberships for one provider; groups are created on first sight. */
  async syncExternalGroups(userId: string, source: AuthSource, externalIds: string[]) {
    const unique = [...new Map(externalIds.map((g) => [g.toLowerCase(), g])).values()];
    const groupIds: string[] = [];
    for (const externalId of unique) {
      const existing = await this.db.selectFrom('groups').select('id').where(sql`lower(external_id)`, '=', externalId.toLowerCase()).executeTakeFirst();
      if (existing) groupIds.push(existing.id);
      else {
        const created = await this.db.insertInto('groups').values({ name: groupNameFrom(externalId), external_id: externalId, source }).returning('id').executeTakeFirstOrThrow();
        groupIds.push(created.id);
      }
    }
    const sourceGroups = this.db.selectFrom('groups').select('id').where('source', '=', source);
    await this.db.deleteFrom('group_members').where('user_id', '=', userId).where('group_id', 'in', sourceGroups).execute();
    if (groupIds.length) {
      await this.db
        .insertInto('group_members')
        .values(groupIds.map((group_id) => ({ group_id, user_id: userId })))
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    await this.publishGroupChanged(groupIds);
  }

  async listGroups(): Promise<Group[]> {
    const rows = await this.db
      .selectFrom('groups')
      .leftJoin('group_members', 'group_members.group_id', 'groups.id')
      .select(['groups.id', 'groups.name', 'groups.external_id', 'groups.source', (eb) => eb.fn.count<number>('group_members.user_id').as('members')])
      .groupBy('groups.id')
      .orderBy('groups.name')
      .execute();
    return rows.map((r) => ({ id: r.id, name: r.name, externalId: r.external_id, source: r.source, memberCount: Number(r.members) }));
  }

  async createGroup(input: { name: string; externalId: string | null }) {
    try {
      const r = await this.db
        .insertInto('groups')
        .values({ name: input.name, external_id: input.externalId, source: input.externalId ? 'ldap' : 'local' })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { id: r.id, name: r.name, externalId: r.external_id, source: r.source, memberCount: 0 };
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict('A group with this directory identifier already exists');
      throw e;
    }
  }

  async updateGroup(id: string, input: { name: string; externalId: string | null }) {
    const r = await this.db.updateTable('groups').set({ name: input.name, external_id: input.externalId }).where('id', '=', id).returningAll().executeTakeFirst();
    if (!r) throw AppError.notFound('Group');
    return (await this.listGroups()).find((g) => g.id === r.id)!;
  }

  async deleteGroup(id: string) {
    await this.db.deleteFrom('grants').where('subject_kind', '=', 'group').where('subject_id', '=', id).execute();
    await this.db.deleteFrom('groups').where('id', '=', id).execute();
  }

  async setGroupMembers(groupId: string, userIds: string[]) {
    await this.transaction(async (tx) => {
      const self = tx as PgIdentityStore;
      const before = (await self.db.selectFrom('group_members').select('user_id').where('group_id', '=', groupId).execute()).map((r) => r.user_id);
      await self.db.deleteFrom('group_members').where('group_id', '=', groupId).execute();
      if (userIds.length) await self.db.insertInto('group_members').values(userIds.map((user_id) => ({ group_id: groupId, user_id }))).execute();
      // Other services match catalog shares to groups through each person's group list.
      const was = new Set(before);
      const now = new Set(userIds);
      for (const id of new Set([...before, ...userIds])) {
        if (was.has(id) === now.has(id)) continue;
        const u = await self.findUserById(id);
        if (u) await self.publishUserChanged(u);
      }
      await self.publishGroupChanged([groupId]);
    });
  }

  async listGroupMembers(groupId: string): Promise<UserSummary[]> {
    const rows = await this.db
      .selectFrom('group_members')
      .innerJoin('users', 'users.id', 'group_members.user_id')
      .select(['users.id', 'users.username', 'users.display_name', 'users.email'])
      .where('group_members.group_id', '=', groupId)
      .orderBy('users.display_name')
      .execute();
    return rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, email: r.email }));
  }

  // ─── Organization units ──────────────────────────────────────────────────

  private unitsQuery() {
    const counts = this.db
      .selectFrom('unit_people')
      .innerJoin('users', 'users.id', 'unit_people.user_id')
      .where('users.active', '=', true)
      .select((eb) => [
        'unit_people.unit_id',
        sql<number>`count(distinct unit_people.user_id) filter (where unit_people.role = 'member')`.as('members'),
        sql<number>`count(distinct unit_people.user_id) filter (where unit_people.role = 'manager')`.as('managers'),
      ])
      .groupBy('unit_people.unit_id')
      .as('c');
    return this.db.selectFrom('org_units').leftJoin(counts, 'c.unit_id', 'org_units.id').selectAll('org_units').select(['c.members', 'c.managers']);
  }

  async listUnits(includeArchived: boolean) {
    let q = this.unitsQuery().orderBy(sql`array_length(org_units.path, 1)`).orderBy(sql`lower(org_units.name)`);
    if (!includeArchived) q = q.where('org_units.archived', '=', false);
    return (await q.execute()).map((r) => toUnit(r as UnitRow));
  }

  async getUnit(id: string) {
    const r = await this.unitsQuery().where('org_units.id', '=', id).executeTakeFirst();
    return r ? toUnit(r as UnitRow) : null;
  }

  async unitKeys() {
    return new Set((await this.db.selectFrom('org_units').select('key').execute()).map((r) => r.key));
  }

  async createUnit(input: OrgUnitInput, parentPath: string[]) {
    const id = globalThis.crypto.randomUUID();
    try {
      await this.db
        .insertInto('org_units')
        .values({
          id,
          key: input.key,
          name: input.name,
          kind: input.kind,
          description: input.description,
          parent_id: input.parentId,
          path: [...parentPath, id],
          color: input.color,
          member_role: input.memberRole,
          directory_members: input.directoryMembers,
          directory_managers: input.directoryManagers,
          archived: input.archived,
        })
        .execute();
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict(`A unit with key "${input.key}" already exists`);
      throw e;
    }
    return (await this.getUnit(id))!;
  }

  /** Updates a unit; when it moves, the whole subtree's paths are rewritten. Returns ids whose path changed. */
  async updateUnit(id: string, input: OrgUnitInput, newPath: string[]): Promise<string[]> {
    const current = await this.db.selectFrom('org_units').select('path').where('id', '=', id).executeTakeFirst();
    if (!current) throw AppError.notFound('Unit');
    await this.db
      .updateTable('org_units')
      .set({
        name: input.name,
        kind: input.kind,
        description: input.description,
        parent_id: input.parentId,
        color: input.color,
        member_role: input.memberRole,
        directory_members: input.directoryMembers,
        directory_managers: input.directoryManagers,
        archived: input.archived,
      })
      .where('id', '=', id)
      .execute();
    if (current.path.join() === newPath.join()) return [];
    const moved = await this.db
      .updateTable('org_units')
      .set({ path: sql`${sql.val(newPath)}::uuid[] || path[(array_position(path, ${id}::uuid) + 1):]` })
      .where(sql<boolean>`${id}::uuid = any(path)`)
      .returning('id')
      .execute();
    return moved.map((r) => r.id);
  }

  async descendantIds(id: string) {
    return (await this.db.selectFrom('org_units').select('id').where(sql<boolean>`${id}::uuid = any(path)`).execute()).map((r) => r.id);
  }

  async unitPeople(unitId: string): Promise<UnitPerson[]> {
    const rows = await this.db
      .selectFrom('unit_people')
      .innerJoin('users', 'users.id', 'unit_people.user_id')
      .select(['users.id', 'users.username', 'users.display_name', 'users.email', 'unit_people.role', 'unit_people.source'])
      .where('unit_people.unit_id', '=', unitId)
      .where('users.active', '=', true)
      .orderBy('unit_people.role', 'desc')
      .orderBy('users.display_name')
      .execute();
    // A person linked both manually and through the directory is listed once, as "directory".
    const seen = new Map<string, UnitPerson>();
    for (const r of rows) {
      const key = `${r.id}|${r.role}`;
      const prev = seen.get(key);
      if (!prev || r.source === 'directory') seen.set(key, { id: r.id, username: r.username, displayName: r.display_name, email: r.email, role: r.role, source: r.source });
    }
    return [...seen.values()];
  }

  async setManualPeople(unitId: string, members: string[], managers: string[]) {
    await this.db.deleteFrom('unit_people').where('unit_id', '=', unitId).where('source', '=', 'manual').execute();
    const rows = [
      ...[...new Set(members)].map((user_id) => ({ unit_id: unitId, user_id, role: 'member' as const, source: 'manual' as const })),
      ...[...new Set(managers)].map((user_id) => ({ unit_id: unitId, user_id, role: 'manager' as const, source: 'manual' as const })),
    ];
    if (rows.length) await this.db.insertInto('unit_people').values(rows).execute();
  }

  /** Directory tags of everyone known: their groups' external ids and attribute tags, lower-cased. */
  private tagsSql(userFilter = sql`true`) {
    return sql`(
      select m.user_id, lower(g.external_id) as tag from group_members m join groups g on g.id = m.group_id
        where g.external_id is not null and ${userFilter}
      union
      select u.id as user_id, lower(t) as tag from users u, unnest(u.directory_tags) t where ${userFilter}
    )`;
  }

  /** Recomputes directory-derived memberships of one unit (after its links change). */
  async syncUnitDirectory(unitId: string) {
    await this.db.deleteFrom('unit_people').where('unit_id', '=', unitId).where('source', '=', 'directory').execute();
    await sql`
      insert into unit_people (unit_id, user_id, role, source)
      select distinct u.id, t.user_id, r.role, 'directory'
      from org_units u
      cross join lateral (values ('member', u.directory_members), ('manager', u.directory_managers)) as r(role, links)
      join ${this.tagsSql()} t on t.tag = any (select lower(x) from unnest(r.links) x)
      where u.id = ${unitId} and not u.archived
      on conflict do nothing`.execute(this.db);
  }

  /** Recomputes one person's directory-derived memberships (at sign-in). Returns units whose managers changed. */
  async syncUserDirectory(userId: string): Promise<string[]> {
    const before = await this.db.selectFrom('unit_people').select('unit_id').where('user_id', '=', userId).where('role', '=', 'manager').execute();
    await this.db.deleteFrom('unit_people').where('user_id', '=', userId).where('source', '=', 'directory').execute();
    await sql`
      insert into unit_people (unit_id, user_id, role, source)
      select distinct u.id, ${userId}::uuid, r.role, 'directory'
      from org_units u
      cross join lateral (values ('member', u.directory_members), ('manager', u.directory_managers)) as r(role, links)
      join ${this.tagsSql(sql`user_id = ${userId}::uuid`)} t on t.tag = any (select lower(x) from unnest(r.links) x)
      where not u.archived
      on conflict do nothing`.execute(this.db);
    const after = await this.db.selectFrom('unit_people').select('unit_id').where('user_id', '=', userId).where('role', '=', 'manager').execute();
    const a = new Set(before.map((r) => r.unit_id));
    const b = new Set(after.map((r) => r.unit_id));
    return [...new Set([...a, ...b])].filter((id) => a.has(id) !== b.has(id));
  }

  async userUnits(userId: string): Promise<Array<{ unitId: string; role: UnitRole }>> {
    const rows = await this.db
      .selectFrom('unit_people')
      .innerJoin('org_units', 'org_units.id', 'unit_people.unit_id')
      .select(['unit_people.unit_id', 'unit_people.role'])
      .distinct()
      .where('unit_people.user_id', '=', userId)
      .where('org_units.archived', '=', false)
      .execute();
    return rows.map((r) => ({ unitId: r.unit_id, role: r.role }));
  }

  async unitManagerIds(unitId: string) {
    const rows = await this.db
      .selectFrom('unit_people')
      .innerJoin('users', 'users.id', 'unit_people.user_id')
      .select('unit_people.user_id')
      .distinct()
      .where('unit_people.unit_id', '=', unitId)
      .where('unit_people.role', '=', 'manager')
      .where('users.active', '=', true)
      .execute();
    return rows.map((r) => r.user_id);
  }

  // ─── Grants ──────────────────────────────────────────────────────────────

  async listGrants(filter: { unitIds?: Array<string | null>; subject?: { kind: SubjectKind; id: string }; ids?: string[] } = {}): Promise<GrantRecord[]> {
    let q = this.db
      .selectFrom('grants')
      .leftJoin('users', (j) => j.onRef('users.id', '=', 'grants.subject_id').on('grants.subject_kind', '=', 'user'))
      .leftJoin('groups', (j) => j.onRef('groups.id', '=', 'grants.subject_id').on('grants.subject_kind', '=', 'group'))
      .leftJoin('org_units', (j) => j.onRef('org_units.id', '=', 'grants.subject_id').on('grants.subject_kind', '=', 'unit'))
      .select([
        'grants.id',
        'grants.subject_kind',
        'grants.subject_id',
        'grants.unit_id',
        'grants.asset_type_id',
        'grants.permissions',
        'grants.created_by_name',
        'grants.created_at',
        'users.display_name',
        'users.email',
        'groups.name as group_name',
        'groups.source as group_source',
        'org_units.name as unit_name',
        'org_units.kind as unit_kind',
        sql<number>`(select count(*) from group_members gm where gm.group_id = grants.subject_id)`.as('group_size'),
      ])
      .orderBy('grants.created_at');
    if (filter.unitIds) {
      const ids = filter.unitIds.filter((x): x is string => !!x);
      q = q.where((eb) => eb.or([...(ids.length ? [eb('grants.unit_id', 'in', ids)] : []), ...(filter.unitIds!.includes(null) ? [eb('grants.unit_id', 'is', null)] : [])]));
    }
    if (filter.subject) q = q.where('grants.subject_kind', '=', filter.subject.kind).where('grants.subject_id', '=', filter.subject.id);
    if (filter.ids) q = q.where('grants.id', 'in', filter.ids);
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      subject: {
        kind: r.subject_kind,
        id: r.subject_id,
        name: r.display_name ?? r.group_name ?? r.unit_name ?? 'Unknown',
        detail:
          r.subject_kind === 'user'
            ? r.email
            : r.subject_kind === 'group'
              ? `${r.group_source === 'local' ? 'Group' : `${r.group_source === 'ldap' ? 'LDAP' : 'ADFS'} group`} · ${Number(r.group_size)} ${Number(r.group_size) === 1 ? 'person' : 'people'}`
              : `${r.unit_kind ?? 'Unit'} · everyone in it`,
      },
      unitId: r.unit_id,
      assetTypeId: r.asset_type_id,
      permissions: normalizePermissions(r.permissions),
      createdByName: r.created_by_name,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async subjectExists(kind: SubjectKind, id: string) {
    const table = kind === 'user' ? 'users' : kind === 'group' ? 'groups' : 'org_units';
    return !!(await this.db.selectFrom(table).select('id').where('id', '=', id).executeTakeFirst());
  }

  async createGrant(input: GrantInput, byName: string) {
    if (!(await this.subjectExists(input.subject.kind, input.subject.id))) throw AppError.validation(`Unknown ${input.subject.kind}`);
    try {
      const r = await this.db
        .insertInto('grants')
        .values({ subject_kind: input.subject.kind, subject_id: input.subject.id, unit_id: input.unitId, asset_type_id: input.assetTypeId, permissions: input.access, created_by_name: byName })
        .returning('id')
        .executeTakeFirstOrThrow();
      return (await this.listGrants({ ids: [r.id] }))[0]!;
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict('They already have access here; change their role instead');
      throw e;
    }
  }

  async getGrant(id: string) {
    return (await this.listGrants({ ids: [id] }))[0] ?? null;
  }

  async updateGrant(id: string, permissions: Permission[]) {
    await this.db.updateTable('grants').set({ permissions }).where('id', '=', id).execute();
    return (await this.getGrant(id))!;
  }

  async deleteGrant(id: string) {
    await this.db.deleteFrom('grants').where('id', '=', id).execute();
  }

  /**
   * Everything a person may do: grants to them, to their directory groups and
   * to any unit they belong to or sit beneath; plus their units' member role
   * and Admin on the units they manage.
   */
  async effectiveGrants(userId: string): Promise<Grant[]> {
    const groupIds = this.db.selectFrom('group_members').select('group_id').where('user_id', '=', userId);
    // Units that contain the person: their units and every ancestor (a grant to R&D reaches its teams).
    const unitIds = this.db
      .selectFrom('unit_people')
      .innerJoin('org_units', 'org_units.id', 'unit_people.unit_id')
      .select(sql<string>`unnest(org_units.path)`.as('id'))
      .where('unit_people.user_id', '=', userId)
      .where('org_units.archived', '=', false);
    const explicit = await this.db
      .selectFrom('grants')
      .select(['unit_id', 'asset_type_id', 'permissions'])
      .where((eb) =>
        eb.or([
          eb.and([eb('subject_kind', '=', 'user'), eb('subject_id', '=', userId)]),
          eb.and([eb('subject_kind', '=', 'group'), eb('subject_id', 'in', groupIds)]),
          eb.and([eb('subject_kind', '=', 'unit'), eb('subject_id', 'in', unitIds)]),
        ]),
      )
      .execute();
    const memberships = await this.db
      .selectFrom('unit_people')
      .innerJoin('org_units', 'org_units.id', 'unit_people.unit_id')
      .select(['unit_people.unit_id', 'unit_people.role', 'org_units.member_role'])
      .where('unit_people.user_id', '=', userId)
      .where('org_units.archived', '=', false)
      .execute();
    const fromUnits: Grant[] = memberships.flatMap((r): Grant[] =>
      r.role === 'manager'
        ? [{ unitId: r.unit_id, assetTypeId: null, permissions: [...roles.admin.permissions] }]
        : r.member_role === 'none'
          ? []
          : [{ unitId: r.unit_id, assetTypeId: null, permissions: [...roles[r.member_role].permissions] }],
    );
    return consolidateGrants([...explicit.map((r) => ({ unitId: r.unit_id, assetTypeId: r.asset_type_id, permissions: normalizePermissions(r.permissions) })), ...fromUnits]);
  }

  /** People, units and directory groups matching a query, for "share with…" pickers. */
  async searchSubjects(q: string, kinds: SubjectKind[], limit = 12): Promise<Subject[]> {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const out: Subject[] = [];
    if (kinds.includes('user')) {
      const rows = await this.db
        .selectFrom('users')
        .select(['id', 'display_name', 'email', 'username'])
        .where('active', '=', true)
        .where((eb) => eb.or([eb('display_name', 'ilike', like), eb('username', 'ilike', like), eb('email', 'ilike', like)]))
        .orderBy('display_name')
        .limit(limit)
        .execute();
      out.push(...rows.map((r): Subject => ({ kind: 'user', id: r.id, name: r.display_name, detail: r.email ?? r.username })));
    }
    if (kinds.includes('unit')) {
      const rows = await this.db.selectFrom('org_units').select(['id', 'name', 'kind']).where('archived', '=', false).where('name', 'ilike', like).orderBy('name').limit(limit).execute();
      out.push(...rows.map((r): Subject => ({ kind: 'unit', id: r.id, name: r.name, detail: `${r.kind} · everyone in it` })));
    }
    if (kinds.includes('group')) {
      const rows = await this.db
        .selectFrom('groups')
        .select(['id', 'name', 'source', sql<number>`(select count(*) from group_members gm where gm.group_id = groups.id)`.as('size')])
        .where((eb) => eb.or([eb('name', 'ilike', like), eb('external_id', 'ilike', like)]))
        .orderBy('name')
        .limit(limit)
        .execute();
      out.push(...rows.map((r): Subject => ({ kind: 'group', id: r.id, name: r.name, detail: `${r.source === 'local' ? 'Group' : `${r.source === 'ldap' ? 'LDAP' : 'ADFS'} group`} · ${Number(r.size)} people` })));
    }
    return out;
  }

  async resolvePeople(values: string[]) {
    const wanted = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
    const out: Record<string, UserSummary | null> = Object.fromEntries(wanted.map((v) => [v, null]));
    if (!wanted.length) return out;
    const lower = wanted.map((v) => v.toLowerCase());
    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'username', 'display_name', 'email'])
      .where('active', '=', true)
      .where((eb) => eb.or([eb(sql`lower(email)`, 'in', lower), eb(sql`lower(username)`, 'in', lower), eb(sql`lower(display_name)`, 'in', lower)]))
      .execute();
    for (const v of wanted) {
      const l = v.toLowerCase();
      // Email and username are unique; a display name only counts when exactly one person has it.
      const exact = rows.find((r) => r.email?.toLowerCase() === l || r.username.toLowerCase() === l);
      const byName = rows.filter((r) => r.display_name.toLowerCase() === l);
      const hit = exact ?? (byName.length === 1 ? byName[0] : undefined);
      out[v] = hit ? { id: hit.id, username: hit.username, displayName: hit.display_name, email: hit.email } : null;
    }
    return out;
  }

  async groupIdsOf(userId: string) {
    return (await this.db.selectFrom('group_members').select('group_id').where('user_id', '=', userId).execute()).map((r) => r.group_id);
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  async createSession(userId: string, tokenHash: string, expiresAt: Date, userAgent: string | null): Promise<Session> {
    const r = await this.db
      .insertInto('sessions')
      .values({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt, user_agent: userAgent?.slice(0, 400) ?? null, revoked_at: null })
      .returning(['id', 'user_id', 'expires_at'])
      .executeTakeFirstOrThrow();
    return { id: r.id, userId: r.user_id, expiresAt: r.expires_at };
  }

  async findSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const r = await this.db.selectFrom('sessions').select(['id', 'user_id', 'expires_at']).where('token_hash', '=', tokenHash).where('revoked_at', 'is', null).executeTakeFirst();
    return r ? { id: r.id, userId: r.user_id, expiresAt: r.expires_at } : null;
  }

  async rotateSession(id: string, tokenHash: string, expiresAt: Date) {
    await this.db.updateTable('sessions').set({ token_hash: tokenHash, expires_at: expiresAt, last_used_at: new Date() }).where('id', '=', id).execute();
  }

  async revokeSession(id: string) {
    await this.db.updateTable('sessions').set({ revoked_at: new Date() }).where('id', '=', id).execute();
  }

  async revokeUserSessions(userId: string) {
    await this.db.updateTable('sessions').set({ revoked_at: new Date() }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
  }

  async purgeExpiredSessions() {
    await this.db.deleteFrom('sessions').where((eb) => eb.or([eb('expires_at', '<', new Date()), eb('revoked_at', 'is not', null)])).execute();
  }

  // ─── Events ──────────────────────────────────────────────────────────────

  async publishUserChanged(u: UserRecord) {
    await enqueue(this.db, 'user.changed', {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      active: u.active,
      preferences: u.preferences,
      groupIds: await this.groupIdsOf(u.id),
    });
  }

  async publishGroupChanged(groupIds: string[]) {
    if (!groupIds.length) return;
    const rows = await this.db
      .selectFrom('groups')
      .select(['id', 'name', 'source', sql<number>`(select count(*) from group_members gm where gm.group_id = groups.id)`.as('size')])
      .where('id', 'in', [...new Set(groupIds)])
      .execute();
    for (const r of rows) await enqueue(this.db, 'group.changed', { groupId: r.id, name: r.name, source: r.source, memberCount: Number(r.size) });
  }

  async publishUnitChanged(unitIds: string[]) {
    for (const id of new Set(unitIds)) {
      const u = await this.getUnit(id);
      if (!u) continue;
      await enqueue(this.db, 'unit.changed', {
        unitId: u.id,
        key: u.key,
        name: u.name,
        kind: u.kind,
        parentId: u.parentId,
        path: u.path,
        archived: u.archived,
        managerIds: await this.unitManagerIds(u.id),
      });
    }
  }
}

/** "CN=Finance Buyers,OU=Groups,DC=corp,DC=example" → "Finance Buyers". */
export function groupNameFrom(externalId: string): string {
  const cn = /^cn=([^,]+)/i.exec(externalId);
  return (cn?.[1] ?? externalId).replace(/\\(.)/g, '$1').slice(0, 120);
}
