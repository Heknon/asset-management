import { AppError, type GrantInput, type Preferences, type PurchaseClassInput } from '@am/core';
import type { IdentityStore } from './ports.js';

/** Administration of people, groups, purchase classes and grants. */
export class DirectoryService {
  constructor(private readonly store: IdentityStore) {}

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
  createGroup(input: { name: string; externalId: string | null }) {
    return this.store.createGroup(input);
  }
  updateGroup(id: string, input: { name: string; externalId: string | null }) {
    return this.store.updateGroup(id, input);
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

  listPurchaseClasses() {
    return this.store.listPurchaseClasses();
  }

  createPurchaseClass(input: PurchaseClassInput) {
    return this.store.transaction(async (tx) => {
      const pc = await tx.createPurchaseClass(input);
      await tx.publishPurchaseClassChanged(pc);
      return pc;
    });
  }

  updatePurchaseClass(id: string, input: PurchaseClassInput) {
    return this.store.transaction(async (tx) => {
      const pc = await tx.updatePurchaseClass(id, input);
      await tx.publishPurchaseClassChanged(pc);
      return pc;
    });
  }

  listGrants(filter?: { principalType?: 'user' | 'group'; principalId?: string }) {
    return this.store.listGrants(filter);
  }

  /** Grant changes reach access tokens on the next refresh (at most ACCESS_TOKEN_TTL later). */
  createGrant(input: GrantInput) {
    return this.store.createGrant(input);
  }

  deleteGrant(id: string) {
    return this.store.deleteGrant(id);
  }
}
