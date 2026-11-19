import { AppError } from '@am/core';
import { Client, type Entry } from 'ldapts';
import * as oidc from 'openid-client';
import type { Logger } from 'pino';
import type { IdentityStore, PasswordHasher, PasswordProvider, RedirectProvider, RedirectState } from '../application/ports.js';
import { normalizeUsername, type ExternalIdentity } from '../domain/model.js';

// ─── Local (break-glass) ─────────────────────────────────────────────────────

export class LocalPasswordProvider implements PasswordProvider {
  readonly info = { id: 'local' as const, label: 'Local account', flow: 'password' as const };

  constructor(
    private readonly store: IdentityStore,
    private readonly hasher: PasswordHasher,
  ) {}

  async authenticate(username: string, password: string): Promise<ExternalIdentity | null> {
    const user = await this.store.findUserByUsername(normalizeUsername(username), 'local');
    const hash = user ? await this.store.getPasswordHash(user.id) : null;
    // Always run a verification so response timing does not reveal whether the account exists.
    const ok = await this.hasher.verify(password, hash ?? DUMMY_HASH);
    if (!user || !hash || !ok || !user.active) return null;
    return { source: 'local', externalId: user.username, username: user.username, displayName: user.displayName, email: user.email, groups: [], directoryAdmin: false };
  }
}

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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
  emailAttribute: string;
  membershipAttribute: string;
  groupBaseDn?: string;
  groupFilter: string;
  adminGroups: string[];
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
        attributes: ['dn', this.s.usernameAttribute, this.s.displayNameAttribute, this.s.emailAttribute, this.s.membershipAttribute],
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
      return {
        source: 'ldap',
        externalId: entry.dn,
        username: normalizeUsername(first(entry[this.s.usernameAttribute]) ?? login),
        displayName: first(entry[this.s.displayNameAttribute]) ?? login,
        email: first(entry[this.s.emailAttribute])?.toLowerCase() ?? null,
        groups,
        directoryAdmin: groups.some((g) => adminSet.has(g.toLowerCase())),
      };
    } catch (err) {
      this.logger.error({ err: { message: (err as Error).message } }, 'LDAP authentication failed');
      throw new AppError('unavailable', 'The directory is not reachable right now');
    } finally {
      await service.unbind().catch(() => undefined);
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
  emailClaim: string;
  groupsClaim: string;
  adminGroups: string[];
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
    return {
      source: 'oidc',
      externalId: claims.sub,
      username,
      displayName: read(this.s.displayNameClaim) ?? read('name') ?? username,
      email: (read(this.s.emailClaim) ?? read('upn'))?.toLowerCase() ?? null,
      groups,
      directoryAdmin: groups.some((g) => adminSet.has(g.toLowerCase())),
    };
  }
}
