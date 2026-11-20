import { AppError, type LocalUserCreate, type Preferences } from '@am/core';
import { normalizeUsername } from '../domain/model.js';
import type { IdentityStore, PasswordHasher } from './ports.js';

/** Administration of people, groups and explicit grants. */
export class DirectoryService {
  constructor(
    private readonly store: IdentityStore,
    private readonly hasher: PasswordHasher,
    /** Google sign-in is on, so people may be added with an email and no password. */
    private readonly passwordless = false,
  ) {}

  async createLocalUser(input: LocalUserCreate) {
    if (input.password === null && !this.passwordless) throw AppError.validation('Give a first password: Google sign-in is not enabled');
    const username = normalizeUsername(input.username);
    if (await this.store.findUserByUsername(username, 'local')) throw AppError.conflict(`A local account "${username}" already exists`);
    return this.store.transaction(async (tx) => {
      const user = await tx.createLocalUser({ username, displayName: input.displayName, email: input.email, passwordHash: input.password === null ? null : await this.hasher.hash(input.password), isAdmin: input.isAdmin });
      await tx.publishUserChanged(user);
      return { id: user.id, username: user.username, displayName: user.displayName, email: user.email };
    });
  }

  /** Admins set a manual account's password; the person is signed out everywhere. */
  async setPassword(id: string, password: string) {
    const user = await this.store.findUserById(id);
    if (!user) throw AppError.notFound('Person');
    if (user.source !== 'local') throw AppError.validation('Only manual accounts have a password here; directory accounts use their company password');
    await this.store.transaction(async (tx) => {
      await tx.setPasswordHash(id, await this.hasher.hash(password));
      await tx.revokeUserSessions(id);
    });
  }

  /** Someone with a manual account changes their own password. */
  async changeOwnPassword(userId: string, current: string, password: string) {
    const user = await this.store.findUserById(userId);
    const hash = await this.store.getPasswordHash(userId);
    if (!user || user.source !== 'local' || !hash) throw AppError.validation('Your account signs in through your company directory; change the password there');
    if (!(await this.hasher.verify(current, hash))) throw AppError.validation('Your current password is not right');
    await this.store.setPasswordHash(userId, await this.hasher.hash(password));
  }

  listUsers(query: { q?: string; ids?: string[]; limit: number; offset: number }) {
    return this.store.listUsers(query);
  }

  /** Minimal directory lookup available to every signed-in user (people pickers). */
  userSummaries(q: string | undefined, ids: string[] | undefined) {
    return this.store.searchUserSummaries(q, ids, 50);
  }

  async updateUser(actorId: string, id: string, patch: { isAdmin?: boolean; active?: boolean }) {
    if (id === actorId && (patch.isAdmin === false || patch.active === false)) {
      throw AppError.validation('You cannot remove your own administrator access or disable yourself');
    }
    return this.store.transaction(async (tx) => {
      const user = await tx.updateUser(id, patch);
      if (patch.active === false) await tx.revokeUserSessions(id);
      await tx.publishUserChanged(user);
      return user;
    });
  }

  async updatePreferences(userId: string, patch: Partial<Preferences>) {
    return this.store.transaction(async (tx) => {
      const current = await tx.findUserById(userId);
      if (!current) throw AppError.notFound('User');
      const user = await tx.updateUser(userId, { preferences: { ...current.preferences, ...patch } });
      await tx.publishUserChanged(user);
      return user.preferences;
    });
  }

  listGroups() {
    return this.store.listGroups();
  }
  resolvePeople(values: string[]) {
    return this.store.resolvePeople(values);
  }

  async createGroup(input: { name: string; externalId: string | null }) {
    const g = await this.store.createGroup(input);
    await this.store.publishGroupChanged([g.id]);
    return g;
  }
  async updateGroup(id: string, input: { name: string; externalId: string | null }) {
    const g = await this.store.updateGroup(id, input);
    await this.store.publishGroupChanged([g.id]);
    return g;
  }
  deleteGroup(id: string) {
    return this.store.deleteGroup(id);
  }
  listGroupMembers(id: string) {
    return this.store.listGroupMembers(id);
  }
  setGroupMembers(id: string, userIds: string[]) {
    return this.store.setGroupMembers(id, userIds);
  }
}
