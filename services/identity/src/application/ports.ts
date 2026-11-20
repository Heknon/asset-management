import type {
  AuthProviderInfo,
  AuthSource,
  Grant,
  GrantInput,
  GrantRecord,
  Permission,
  Subject,
  SubjectKind,
  Group,
  Page,
  Preferences,
  SignedInSession,
  OrgUnit,
  OrgUnitInput,
  UnitPerson,
  UnitRole,
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
  setPasswordHash(userId: string, hash: string): Promise<void>;
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

  listUnits(includeArchived: boolean): Promise<OrgUnit[]>;
  getUnit(id: string): Promise<OrgUnit | null>;
  unitKeys(): Promise<Set<string>>;
  createUnit(input: OrgUnitInput, parentPath: string[]): Promise<OrgUnit>;
  /** Returns ids of units whose ancestor path changed (the unit and its subtree, when moved). */
  updateUnit(id: string, input: OrgUnitInput, newPath: string[]): Promise<string[]>;
  descendantIds(id: string): Promise<string[]>;
  unitPeople(unitId: string): Promise<UnitPerson[]>;
  setManualPeople(unitId: string, members: string[], managers: string[]): Promise<void>;
  syncUnitDirectory(unitId: string): Promise<void>;
  /** Returns units whose set of managers changed. */
  syncUserDirectory(userId: string): Promise<string[]>;
  userUnits(userId: string): Promise<Array<{ unitId: string; role: UnitRole }>>;

  listGrants(filter?: { unitIds?: Array<string | null>; subject?: { kind: SubjectKind; id: string }; ids?: string[] }): Promise<GrantRecord[]>;
  getGrant(id: string): Promise<GrantRecord | null>;
  createGrant(input: GrantInput, byName: string): Promise<GrantRecord>;
  updateGrant(id: string, permissions: Permission[]): Promise<GrantRecord>;
  deleteGrant(id: string): Promise<void>;
  searchSubjects(q: string, kinds: SubjectKind[], limit?: number): Promise<Subject[]>;
  resolvePeople(values: string[]): Promise<Record<string, UserSummary | null>>;
  effectiveGrants(userId: string): Promise<Grant[]>;

  createSession(userId: string, tokenHash: string, expiresAt: Date, userAgent: string | null): Promise<Session>;
  findSessionByTokenHash(tokenHash: string): Promise<Session | null>;
  rotateSession(id: string, tokenHash: string, expiresAt: Date): Promise<void>;
  revokeSession(id: string): Promise<void>;
  /** A person's active sessions, most recently used first. */
  listSessions(userId: string): Promise<SignedInSession[]>;
  /** Revokes one of the person's own sessions; false when it is not theirs or already gone. */
  revokeOwnSession(userId: string, id: string): Promise<boolean>;
  revokeUserSessions(userId: string): Promise<void>;

  publishUserChanged(user: UserRecord): Promise<void>;
  publishUnitChanged(unitIds: string[]): Promise<void>;
  publishGroupChanged(groupIds: string[]): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface TokenIssuer {
  issueAccessToken(
    claims: { userId: string; username: string; displayName: string; email: string | null; isAdmin: boolean; grants: Grant[]; units: Array<{ unitId: string; role: UnitRole }> },
    opts?: { audience?: string[]; ttlSeconds?: number },
  ): Promise<string>;
  jwks(): Promise<{ keys: unknown[] }>;
}

export type { Preferences };
