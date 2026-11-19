import { AppError, type LocalUserCreate, type Preferences } from '@am/core';
import { normalizeUsername } from '../domain/model.js';
import type { IdentityStore, PasswordHasher } from './ports.js';

/** Administration of people, groups and explicit grants. */
export class DirectoryService {
  constructor(
    private readonly store: IdentityStore,
    private readonly hasher: PasswordHasher,
  ) {}

  async createLocalUser(input: LocalUserCreate) {
    const username = normalizeUsername(input.username);
    if (await this.store.findUserByUsername(username, 'local')) throw AppError.conflict(`A local account "${username}" already exists`);
    return this.store.transaction(async (tx) => {
      const user = await tx.createLocalUser({ username, displayName: input.displayName, email: input.email, passwordHash: await this.hasher.hash(input.password), isAdmin: input.isAdmin });
      await tx.publishUserChanged(user);
      return { id: user.id, username: user.username, displayName: user.displayName, email: user.email };
    });
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
