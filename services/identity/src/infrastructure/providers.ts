import { AppError } from '@am/core';
import { Client, type Entry } from 'ldapts';
import * as oidc from 'openid-client';
import type { Logger } from 'pino';
import type { DirectoryCrawler, PasswordProvider, RedirectProvider, RedirectState } from '../application/ports.js';
import { orgAttributeCandidates, type DirectoryPerson } from '../domain/directory.js';
import { normalizeUsername, otherNamesOf, type ExternalIdentity } from '../domain/model.js';

// ─── LDAP / Active Directory ─────────────────────────────────────────────────

export interface LdapSettings {
  label: string;
  url: string;
  startTls: boolean;
  caCert?: string;
  bindDn: string;
  bindPassword: string;
  userBaseDn: string;
  userFilter: string;
  usernameAttribute: string;
  displayNameAttribute: string;
  /** Further name attributes kept for search, e.g. givenName, sn, cn. */
  nameAttributes: string[];
  emailAttribute: string;
  membershipAttribute: string;
  groupBaseDn?: string;
  groupFilter: string;
  adminGroups: string[];
  /** User attributes that place people in units, e.g. department, division. */
  unitAttributes: string[];
  /** Who is everyone (the directory import): e.g. people, not computers or service accounts. */
  crawlFilter: string;
  /** The attribute naming someone's manager (a DN). */
  managerAttribute: string;
}

/** RFC 4515 filter value escaping — prevents LDAP injection through the username. */
export function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\u0000/]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

const first = (v: Entry[string] | undefined): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return x === undefined ? null : x.toString();
};
const all = (v: Entry[string] | undefined): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => x.toString()));

export class LdapPasswordProvider implements PasswordProvider {
  readonly info;

  constructor(
    private readonly s: LdapSettings,
    private readonly logger: Logger,
  ) {
    this.info = { id: 'ldap' as const, label: s.label, flow: 'password' as const };
  }

  private client(): Client {
    return new Client({
      url: this.s.url,
      timeout: 10_000,
      connectTimeout: 5_000,
      tlsOptions: this.s.caCert ? { ca: [this.s.caCert], minVersion: 'TLSv1.2' } : { minVersion: 'TLSv1.2' },
    });
  }

  private async connect(c: Client) {
    if (this.s.startTls) await c.startTLS(this.s.caCert ? { ca: [this.s.caCert] } : {});
  }

  async authenticate(username: string, password: string): Promise<ExternalIdentity | null> {
    const login = normalizeUsername(username);
    // An empty password would be an anonymous ("unauthenticated") bind that many servers accept.
    if (!login || !password) return null;

    const service = this.client();
    let entry: Entry | undefined;
    try {
      await this.connect(service);
      await service.bind(this.s.bindDn, this.s.bindPassword);
      const { searchEntries } = await service.search(this.s.userBaseDn, {
        scope: 'sub',
        filter: this.s.userFilter.replaceAll('{username}', escapeLdapFilter(login)),
        attributes: ['dn', this.s.usernameAttribute, this.s.displayNameAttribute, ...this.s.nameAttributes, this.s.emailAttribute, this.s.membershipAttribute, ...this.s.unitAttributes, ...orgAttributeCandidates],
        sizeLimit: 2,
      });
      if (searchEntries.length !== 1) return null;
      entry = searchEntries[0]!;

      let groups = all(entry[this.s.membershipAttribute]);
      if (this.s.groupBaseDn) {
        const { searchEntries: groupEntries } = await service.search(this.s.groupBaseDn, {
          scope: 'sub',
          filter: this.s.groupFilter.replaceAll('{dn}', escapeLdapFilter(entry.dn)),
          attributes: ['dn'],
        });
        groups = [...groups, ...groupEntries.map((g) => g.dn)];
      }

      const user = this.client();
      try {
        await this.connect(user);
        await user.bind(entry.dn, password);
      } catch {
        return null;
      } finally {
        await user.unbind().catch(() => undefined);
      }

      const adminSet = new Set(this.s.adminGroups.map((g) => g.toLowerCase()));
      const username = normalizeUsername(first(entry[this.s.usernameAttribute]) ?? login);
      const displayName = first(entry[this.s.displayNameAttribute]) ?? login;
      const email = first(entry[this.s.emailAttribute])?.toLowerCase() ?? null;
      return {
        source: 'ldap',
        externalId: entry.dn,
        username,
        displayName,
        email,
        otherNames: otherNamesOf(this.s.nameAttributes.flatMap((a) => all(entry![a])), [displayName, username, email]),
        groups,
        tags: attributeTags(this.s.unitAttributes, (a) => all(entry![a])),
        directoryAdmin: groups.some((g) => adminSet.has(g.toLowerCase())),
        // The org tree's rule places people by these (it is applied at sign-in too).
        attributes: Object.fromEntries(orgAttributeCandidates.map((a) => [a, all(entry![a])]).filter(([, v]) => (v?.length ?? 0) > 0)),
      };
    } catch (err) {
      this.logger.error({ err: { message: (err as Error).message } }, 'LDAP authentication failed');
      throw new AppError('unavailable', 'The directory is not reachable right now');
    } finally {
      await service.unbind().catch(() => undefined);
    }
  }
}

/**
 * Reads everyone in the directory for the import: page by page, people only
 * (not computers or disabled accounts), with where they sit and who their
 * manager is. Group memberships come from the membership attribute (memberOf).
 */
export class LdapCrawler implements DirectoryCrawler {
  constructor(
    private readonly s: LdapSettings,
    private readonly logger: Logger,
  ) {}

  async crawl(limit: number): Promise<{ people: DirectoryPerson[]; complete: boolean }> {
    const c = new Client({
      url: this.s.url,
      timeout: 60_000,
      connectTimeout: 5_000,
      tlsOptions: this.s.caCert ? { ca: [this.s.caCert], minVersion: 'TLSv1.2' } : { minVersion: 'TLSv1.2' },
    });
    const people: DirectoryPerson[] = [];
    let complete = true;
    try {
      if (this.s.startTls) await c.startTLS(this.s.caCert ? { ca: [this.s.caCert] } : {});
      await c.bind(this.s.bindDn, this.s.bindPassword);
      const attributes = [
        this.s.usernameAttribute,
        this.s.displayNameAttribute,
        ...this.s.nameAttributes,
        this.s.emailAttribute,
        this.s.membershipAttribute,
        this.s.managerAttribute,
        ...this.s.unitAttributes,
        'userAccountControl',
        ...orgAttributeCandidates,
      ];
      pages: for await (const page of c.searchPaginated(this.s.userBaseDn, { scope: 'sub', filter: this.s.crawlFilter, attributes, paged: { pageSize: 500 } })) {
        for (const e of page.searchEntries) {
          // Active Directory: "account disabled" is bit 2 of userAccountControl.
          const uac = Number(first(e.userAccountControl) ?? 0);
          if (uac & 2) continue;
          const username = first(e[this.s.usernameAttribute]);
          if (!username) continue;
          if (people.length >= limit) {
            complete = false;
            break pages;
          }
          const displayName = first(e[this.s.displayNameAttribute]) ?? username;
          const email = first(e[this.s.emailAttribute])?.toLowerCase() ?? null;
          people.push({
            dn: e.dn,
            username: normalizeUsername(username),
            displayName,
            email,
            otherNames: otherNamesOf(this.s.nameAttributes.flatMap((a) => all(e[a])), [displayName, username, email]),
            groups: all(e[this.s.membershipAttribute]),
            attributes: Object.fromEntries(orgAttributeCandidates.map((a) => [a, all(e[a])]).filter(([, v]) => (v?.length ?? 0) > 0)),
            managerDn: first(e[this.s.managerAttribute]),
            tags: attributeTags(this.s.unitAttributes, (a) => all(e[a])),
            directoryAdmin: all(e[this.s.membershipAttribute]).some((g) => this.s.adminGroups.some((x) => x.toLowerCase() === g.toLowerCase())),
          });
        }
      }
      return { people, complete };
    } catch (err) {
      this.logger.error({ err: { message: (err as Error).message } }, 'LDAP crawl failed');
      throw new AppError('unavailable', 'The directory could not be read right now');
    } finally {
      await c.unbind().catch(() => undefined);
    }
  }
}

// ─── ADFS / OpenID Connect ───────────────────────────────────────────────────

export interface OidcSettings {
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  usernameClaim: string;
  displayNameClaim: string;
  /** Further name claims kept for search, e.g. given_name, family_name. */
  nameClaims: string[];
  emailClaim: string;
  groupsClaim: string;
  adminGroups: string[];
  /** ID token claims that place people in units, e.g. department. */
  unitClaims: string[];
}

export class OidcRedirectProvider implements RedirectProvider {
  readonly info;
  private config: Promise<oidc.Configuration> | null = null;

  constructor(private readonly s: OidcSettings) {
    this.info = { id: 'oidc' as const, label: s.label, flow: 'redirect' as const };
  }

  /** Discovery is lazy and retried, so an ADFS outage does not block service startup. */
  private configuration(): Promise<oidc.Configuration> {
    this.config ??= oidc.discovery(new URL(this.s.issuer), this.s.clientId, this.s.clientSecret).catch((err) => {
      this.config = null;
      throw err;
    });
    return this.config;
  }

  async begin(redirectUri: string): Promise<{ url: string; state: RedirectState }> {
    const config = await this.configuration();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state: RedirectState = { state: oidc.randomState(), nonce: oidc.randomNonce(), codeVerifier };
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: this.s.scopes,
      response_type: 'code',
      response_mode: 'query',
      state: state.state,
      nonce: state.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    return { url: url.href, state };
  }

  async complete(callbackUrl: URL, state: RedirectState): Promise<ExternalIdentity> {
    const config = await this.configuration();
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: state.codeVerifier,
        expectedState: state.state,
        expectedNonce: state.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      throw AppError.unauthenticated(`Single sign-on failed: ${(err as Error).message}`);
    }
    const claims = tokens.claims();
    if (!claims) throw AppError.unauthenticated('Single sign-on returned no identity');
    const read = (name: string) => {
      const v = (claims as Record<string, unknown>)[name];
      return typeof v === 'string' ? v : null;
    };
    const rawGroups = (claims as Record<string, unknown>)[this.s.groupsClaim];
    const groups = (Array.isArray(rawGroups) ? rawGroups : typeof rawGroups === 'string' ? [rawGroups] : []).map(String);
    const username = normalizeUsername(read(this.s.usernameClaim) ?? read('preferred_username') ?? claims.sub);
    const adminSet = new Set(this.s.adminGroups.map((g) => g.toLowerCase()));
    const displayName = read(this.s.displayNameClaim) ?? read('name') ?? username;
    const email = (read(this.s.emailClaim) ?? read('upn'))?.toLowerCase() ?? null;
    return {
      source: 'oidc',
      externalId: claims.sub,
      username,
      displayName,
      email,
      otherNames: otherNamesOf(this.s.nameClaims.map(read).filter((v): v is string => !!v), [displayName, username, email]),
      groups,
      tags: attributeTags(this.s.unitClaims, (c) => {
        const v = (claims as Record<string, unknown>)[c];
        return Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
      }),
      directoryAdmin: groups.some((g) => adminSet.has(g.toLowerCase())),
    };
  }
}

/** `department` + ["Platform"] → ["department=Platform"]: matched against unit directory links. */
export function attributeTags(names: string[], read: (name: string) => string[]): string[] {
  return names.flatMap((n) => read(n).filter(Boolean).map((v) => `${n}=${v}`));
}
