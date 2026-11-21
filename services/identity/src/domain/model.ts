import type { AuthSource, Grant, Preferences } from '@am/core';

/** What an identity provider tells us about a person after authenticating them. */
export interface ExternalIdentity {
  source: AuthSource;
  /** Stable id at the provider: LDAP DN, OIDC `sub`, or the local username. */
  externalId: string;
  username: string;
  displayName: string;
  email: string | null;
  /** Other names the directory knows the person by (first name, surname, full name, account names), for search. */
  otherNames: string[];
  /** Provider group identifiers (LDAP DNs / ADFS group claim values). */
  groups: string[];
  /** Directory attributes used to place people in units, as `attribute=value` (e.g. `department=Platform`). */
  tags: string[];
  /** Provider says this person is an administrator (member of a configured admin group). */
  directoryAdmin: boolean;
  /** Directory attributes that may say where the person sits (company, division, department…), for the org tree's rule. */
  attributes?: Record<string, string[]>;
}

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  otherNames: string[];
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

/**
 * The names worth searching besides the display name, username and email: trimmed, without
 * duplicates (ignoring case) and without the ones already stored elsewhere.
 */
export function otherNamesOf(values: string[], known: (string | null)[]): string[] {
  const seen = new Set(known.filter((v): v is string => !!v).map((v) => v.trim().toLowerCase()));
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
