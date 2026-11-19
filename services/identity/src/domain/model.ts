import type { AuthSource, Grant, Preferences } from '@am/core';

/** What an identity provider tells us about a person after authenticating them. */
export interface ExternalIdentity {
  source: AuthSource;
  /** Stable id at the provider: LDAP DN, OIDC `sub`, or the local username. */
  externalId: string;
  username: string;
  displayName: string;
  email: string | null;
  /** Provider group identifiers (LDAP DNs / ADFS group claim values). */
  groups: string[];
  /** Provider says this person is an administrator (member of a configured admin group). */
  directoryAdmin: boolean;
}

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  source: AuthSource;
  externalId: string | null;
  isAdmin: boolean;
  directoryAdmin: boolean;
  active: boolean;
  preferences: Preferences;
  lastLoginAt: Date | null;
}

export const defaultPreferences: Preferences = { emailReminders: true, outlookInvites: true };

export function isAdministrator(user: Pick<UserRecord, 'isAdmin' | 'directoryAdmin'>): boolean {
  return user.isAdmin || user.directoryAdmin;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

export type { Grant };

/** Login names are compared case-insensitively and without a leading DOMAIN\ prefix. */
export function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  const withoutDomain = trimmed.includes('\\') ? trimmed.slice(trimmed.lastIndexOf('\\') + 1) : trimmed;
  return withoutDomain.toLowerCase();
}
