import { AppError, consolidateGrants, type AuthSource, type Grant, type GrantInput, type GrantRecord, type Group, type OrgUnit, type OrgUnitInput, type Page, type UnitPerson, type UnitRole, type User, type UserSummary } from '@am/core';
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
  memberAccess: r.member_access,
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
    await this.db.deleteFrom('grants').where('principal_type', '=', 'group').where('principal_id', '=', id).execute();
    await this.db.deleteFrom('groups').where('id', '=', id).execute();
  }

  async setGroupMembers(groupId: string, userIds: string[]) {
    await this.transaction(async (tx) => {
      const self = tx as PgIdentityStore;
      await self.db.deleteFrom('group_members').where('group_id', '=', groupId).execute();
      if (userIds.length) await self.db.insertInto('group_members').values(userIds.map((user_id) => ({ group_id: groupId, user_id }))).execute();
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
          member_access: input.memberAccess,
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
        member_access: input.memberAccess,
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

  async listGrants(filter: { principalType?: 'user' | 'group'; principalId?: string } = {}): Promise<GrantRecord[]> {
    let q = this.db
      .selectFrom('grants')
      .leftJoin('users', (j) => j.onRef('users.id', '=', 'grants.principal_id').on('grants.principal_type', '=', 'user'))
      .leftJoin('groups', (j) => j.onRef('groups.id', '=', 'grants.principal_id').on('grants.principal_type', '=', 'group'))
      .select(['grants.id', 'grants.principal_type', 'grants.principal_id', 'grants.unit_id', 'grants.asset_type_id', 'grants.level', 'users.display_name', 'groups.name as group_name'])
      .orderBy('grants.created_at');
    if (filter.principalType) q = q.where('grants.principal_type', '=', filter.principalType);
    if (filter.principalId) q = q.where('grants.principal_id', '=', filter.principalId);
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      principalType: r.principal_type,
      principalId: r.principal_id,
      principalName: r.display_name ?? r.group_name ?? 'Unknown',
      unitId: r.unit_id,
      assetTypeId: r.asset_type_id,
      level: r.level,
    }));
  }

  async createGrant(input: GrantInput) {
    const table = input.principalType === 'user' ? 'users' : 'groups';
    const exists = await this.db.selectFrom(table).select('id').where('id', '=', input.principalId).executeTakeFirst();
    if (!exists) throw AppError.validation(`Unknown ${input.principalType}`);
    try {
      const r = await this.db
        .insertInto('grants')
        .values({ principal_type: input.principalType, principal_id: input.principalId, unit_id: input.unitId, asset_type_id: input.assetTypeId, level: input.level })
        .returning('id')
        .executeTakeFirstOrThrow();
      return (await this.listGrants()).find((g) => g.id === r.id)!;
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict('An identical grant already exists; change its level instead');
      throw e;
    }
  }

  async deleteGrant(id: string) {
    await this.db.deleteFrom('grants').where('id', '=', id).execute();
  }

  /**
   * Everything a person may do: explicit grants to them or their groups, plus
   * unit membership (the unit's member access) and management (manage), each
   * applying to the unit's subtree. Collapsed to the highest level per scope.
   */
  async effectiveGrants(userId: string): Promise<Grant[]> {
    const groupIds = this.db.selectFrom('group_members').select('group_id').where('user_id', '=', userId);
    const explicit = await this.db
      .selectFrom('grants')
      .select(['unit_id', 'asset_type_id', 'level'])
      .where((eb) =>
        eb.or([
          eb.and([eb('principal_type', '=', 'user'), eb('principal_id', '=', userId)]),
          eb.and([eb('principal_type', '=', 'group'), eb('principal_id', 'in', groupIds)]),
        ]),
      )
      .execute();
    const roles = await this.db
      .selectFrom('unit_people')
      .innerJoin('org_units', 'org_units.id', 'unit_people.unit_id')
      .select(['unit_people.unit_id', 'unit_people.role', 'org_units.member_access'])
      .where('unit_people.user_id', '=', userId)
      .where('org_units.archived', '=', false)
      .execute();
    const fromUnits: Grant[] = roles.flatMap((r): Grant[] =>
      r.role === 'manager' ? [{ unitId: r.unit_id, assetTypeId: null, level: 'manage' }] : r.member_access === 'none' ? [] : [{ unitId: r.unit_id, assetTypeId: null, level: r.member_access }],
    );
    return consolidateGrants([...explicit.map((r) => ({ unitId: r.unit_id, assetTypeId: r.asset_type_id, level: r.level })), ...fromUnits]);
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

  publishUserChanged(u: UserRecord) {
    return enqueue(this.db, 'user.changed', {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      active: u.active,
      preferences: u.preferences,
    });
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
