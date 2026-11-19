import { AppError, consolidateGrants, type AuthSource, type Grant, type GrantInput, type GrantRecord, type Group, type Page, type PurchaseClass, type PurchaseClassInput, type User, type UserSummary } from '@am/core';
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

const toPurchaseClass = (r: Selectable<IdentityDB['purchase_classes']>): PurchaseClass => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  color: r.color,
  archived: r.archived,
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
          ...(identity.source === 'local' ? {} : { directory_admin: identity.directoryAdmin }),
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

  // ─── Purchase classes ────────────────────────────────────────────────────

  async listPurchaseClasses() {
    return (await this.db.selectFrom('purchase_classes').selectAll().orderBy('name').execute()).map(toPurchaseClass);
  }

  async createPurchaseClass(input: PurchaseClassInput) {
    try {
      return toPurchaseClass(await this.db.insertInto('purchase_classes').values(input).returningAll().executeTakeFirstOrThrow());
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict(`Purchase class "${input.key}" already exists`);
      throw e;
    }
  }

  async updatePurchaseClass(id: string, input: PurchaseClassInput) {
    const r = await this.db.updateTable('purchase_classes').set(input).where('id', '=', id).returningAll().executeTakeFirst();
    if (!r) throw AppError.notFound('Purchase class');
    return toPurchaseClass(r);
  }

  // ─── Grants ──────────────────────────────────────────────────────────────

  async listGrants(filter: { principalType?: 'user' | 'group'; principalId?: string } = {}): Promise<GrantRecord[]> {
    let q = this.db
      .selectFrom('grants')
      .leftJoin('users', (j) => j.onRef('users.id', '=', 'grants.principal_id').on('grants.principal_type', '=', 'user'))
      .leftJoin('groups', (j) => j.onRef('groups.id', '=', 'grants.principal_id').on('grants.principal_type', '=', 'group'))
      .select(['grants.id', 'grants.principal_type', 'grants.principal_id', 'grants.purchase_class_id', 'grants.asset_type_id', 'grants.level', 'users.display_name', 'groups.name as group_name'])
      .orderBy('grants.created_at');
    if (filter.principalType) q = q.where('grants.principal_type', '=', filter.principalType);
    if (filter.principalId) q = q.where('grants.principal_id', '=', filter.principalId);
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      principalType: r.principal_type,
      principalId: r.principal_id,
      principalName: r.display_name ?? r.group_name ?? 'Unknown',
      purchaseClassId: r.purchase_class_id,
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
        .values({ principal_type: input.principalType, principal_id: input.principalId, purchase_class_id: input.purchaseClassId, asset_type_id: input.assetTypeId, level: input.level })
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

  /** Direct grants plus grants of every group the user belongs to, collapsed to the highest level per scope. */
  async effectiveGrants(userId: string): Promise<Grant[]> {
    const groupIds = this.db.selectFrom('group_members').select('group_id').where('user_id', '=', userId);
    const rows = await this.db
      .selectFrom('grants')
      .select(['purchase_class_id', 'asset_type_id', 'level'])
      .where((eb) =>
        eb.or([
          eb.and([eb('principal_type', '=', 'user'), eb('principal_id', '=', userId)]),
          eb.and([eb('principal_type', '=', 'group'), eb('principal_id', 'in', groupIds)]),
        ]),
      )
      .execute();
    return consolidateGrants(rows.map((r) => ({ purchaseClassId: r.purchase_class_id, assetTypeId: r.asset_type_id, level: r.level })));
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

  publishPurchaseClassChanged(pc: PurchaseClass) {
    return enqueue(this.db, 'purchase-class.changed', { purchaseClassId: pc.id, key: pc.key, name: pc.name, archived: pc.archived });
  }
}

/** "CN=Finance Buyers,OU=Groups,DC=corp,DC=example" → "Finance Buyers". */
export function groupNameFrom(externalId: string): string {
  const cn = /^cn=([^,]+)/i.exec(externalId);
  return (cn?.[1] ?? externalId).replace(/\\(.)/g, '$1').slice(0, 120);
}
