import type {
  AuthProviderInfo,
  AuthSource,
  Grant,
  GrantInput,
  GrantRecord,
  Group,
  Page,
  Preferences,
  PurchaseClass,
  PurchaseClassInput,
  User,
  UserSummary,
} from '@am/core';
import type { ExternalIdentity, Session, UserRecord } from '../domain/model.js';

/** Authenticates a username/password pair (local accounts, LDAP). */
export interface PasswordProvider {
  readonly info: AuthProviderInfo;
  authenticate(username: string, password: string): Promise<ExternalIdentity | null>;
}

/** Browser redirect flow (ADFS / OpenID Connect). */
export interface RedirectProvider {
  readonly info: AuthProviderInfo;
  begin(redirectUri: string): Promise<{ url: string; state: RedirectState }>;
  complete(callbackUrl: URL, state: RedirectState): Promise<ExternalIdentity>;
}

export interface RedirectState {
  state: string;
  nonce: string;
  codeVerifier: string;
}

/**
 * Persistence port for the identity context. One interface, one adapter:
 * the application layer never sees SQL.
 */
export interface IdentityStore {
  transaction<T>(fn: (store: IdentityStore) => Promise<T>): Promise<T>;

  findUserById(id: string): Promise<UserRecord | null>;
  findUserByUsername(username: string, source: AuthSource): Promise<UserRecord | null>;
  findUserByExternalId(source: AuthSource, externalId: string): Promise<UserRecord | null>;
  getPasswordHash(userId: string): Promise<string | null>;
  upsertUserFromIdentity(identity: ExternalIdentity): Promise<UserRecord>;
  createLocalUser(input: { username: string; displayName: string; email: string | null; passwordHash: string; isAdmin: boolean }): Promise<UserRecord>;
  updateUser(id: string, patch: Partial<Pick<UserRecord, 'isAdmin' | 'active' | 'preferences'>>): Promise<UserRecord>;
  touchLogin(id: string): Promise<void>;
  listUsers(query: { q?: string; ids?: string[]; limit: number; offset: number }): Promise<Page<User>>;
  searchUserSummaries(q: string | undefined, ids: string[] | undefined, limit: number): Promise<UserSummary[]>;

  syncExternalGroups(userId: string, source: AuthSource, externalIds: string[]): Promise<void>;
  listGroups(): Promise<Group[]>;
  createGroup(input: { name: string; externalId: string | null }): Promise<Group>;
  updateGroup(id: string, input: { name: string; externalId: string | null }): Promise<Group>;
  deleteGroup(id: string): Promise<void>;
  setGroupMembers(groupId: string, userIds: string[]): Promise<void>;
  listGroupMembers(groupId: string): Promise<UserSummary[]>;

  listPurchaseClasses(): Promise<PurchaseClass[]>;
  createPurchaseClass(input: PurchaseClassInput): Promise<PurchaseClass>;
  updatePurchaseClass(id: string, input: PurchaseClassInput): Promise<PurchaseClass>;

  listGrants(filter?: { principalType?: 'user' | 'group'; principalId?: string }): Promise<GrantRecord[]>;
  createGrant(input: GrantInput): Promise<GrantRecord>;
  deleteGrant(id: string): Promise<void>;
  effectiveGrants(userId: string): Promise<Grant[]>;

  createSession(userId: string, tokenHash: string, expiresAt: Date, userAgent: string | null): Promise<Session>;
  findSessionByTokenHash(tokenHash: string): Promise<Session | null>;
  rotateSession(id: string, tokenHash: string, expiresAt: Date): Promise<void>;
  revokeSession(id: string): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;

  publishUserChanged(user: UserRecord): Promise<void>;
  publishPurchaseClassChanged(pc: PurchaseClass): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface TokenIssuer {
  issueAccessToken(claims: { userId: string; username: string; displayName: string; email: string | null; isAdmin: boolean; grants: Grant[] }): Promise<string>;
  jwks(): Promise<{ keys: unknown[] }>;
}

export type { Preferences };
