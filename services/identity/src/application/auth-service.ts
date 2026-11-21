import { metrics, randomToken, sha256Hex } from '@am/platform';
import { AppError, type AuthProviderInfo, type Me, type PasswordLogin, type SignedInSession } from '@am/core';
import { isAdministrator, type ExternalIdentity, type UserRecord } from '../domain/model.js';
import type { IdentityStore, PasswordProvider, RedirectProvider, RedirectState, TokenIssuer } from './ports.js';
import { orgTagFor } from './directory-import.js';

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: UserRecord;
}

const logins = metrics.counter({ name: 'am_logins_total', help: 'Sign-in attempts by provider and outcome', labelNames: ['provider', 'outcome'] });

const hashToken = (token: string) => sha256Hex(token);

export class AuthService {
  constructor(
    private readonly store: IdentityStore,
    private readonly tokens: TokenIssuer,
    private readonly passwordProviders: ReadonlyMap<string, PasswordProvider>,
    private readonly redirectProvider: RedirectProvider | null,
    private readonly sessionTtlMs: number,
    private readonly google = false,
  ) {}

  providers(): AuthProviderInfo[] {
    return [
      ...[...this.passwordProviders.values()].map((p) => p.info),
      ...(this.redirectProvider ? [this.redirectProvider.info] : []),
      ...(this.google ? [{ id: 'google' as const, label: 'Google', flow: 'redirect' as const }] : []),
    ];
  }

  /**
   * Google sign-in: the account whose email Google verified. Nobody is created
   * here; an administrator adds people first (Add person, with their email).
   */
  async loginWithVerifiedEmail(email: string, userAgent: string | null): Promise<IssuedSession> {
    const found = await this.store.findUsersByEmail(email);
    if (found.length !== 1) {
      logins.inc({ provider: 'google', outcome: 'rejected' });
      throw found.length
        ? AppError.forbidden('Several accounts use this email. Ask an administrator to keep one.')
        : AppError.forbidden('No account uses this Google address. Ask an administrator to add you.');
    }
    const user = found[0]!;
    if (!user.active) throw AppError.forbidden('This account has been disabled');
    await this.store.touchLogin(user.id);
    logins.inc({ provider: 'google', outcome: 'success' });
    return this.sessionFor(user.id, userAgent ?? '');
  }

  async loginWithPassword(input: PasswordLogin, userAgent: string | null): Promise<IssuedSession> {
    const provider = this.passwordProviders.get(input.provider);
    if (!provider) throw AppError.validation(`Sign-in method "${input.provider}" is not enabled`);
    const identity = await provider.authenticate(input.username, input.password).catch((err) => {
      logins.inc({ provider: input.provider, outcome: 'error' });
      throw err;
    });
    if (!identity) {
      logins.inc({ provider: input.provider, outcome: 'rejected' });
      throw AppError.unauthenticated('Invalid username or password');
    }
    logins.inc({ provider: input.provider, outcome: 'success' });
    return this.establish(identity, userAgent);
  }

  beginRedirect(redirectUri: string): Promise<{ url: string; state: RedirectState }> {
    if (!this.redirectProvider) throw AppError.validation('Single sign-on is not enabled');
    return this.redirectProvider.begin(redirectUri);
  }

  async completeRedirect(callbackUrl: URL, state: RedirectState, userAgent: string | null): Promise<IssuedSession> {
    if (!this.redirectProvider) throw AppError.validation('Single sign-on is not enabled');
    const identity = await this.redirectProvider.complete(callbackUrl, state).catch((err) => {
      logins.inc({ provider: 'oidc', outcome: 'rejected' });
      throw err;
    });
    logins.inc({ provider: 'oidc', outcome: 'success' });
    return this.establish(identity, userAgent);
  }

  /**
   * A session for someone already signed in, e.g. when they let an MCP client
   * act for them: its own refresh token (revocable like any session) and access
   * tokens that also name `audience`.
   */
  async sessionFor(userId: string, userAgent: string, token: { audience?: string[]; ttlSeconds?: number } = {}): Promise<IssuedSession> {
    const user = await this.store.findUserById(userId);
    if (!user?.active) throw AppError.unauthenticated('Account disabled');
    const refreshToken = randomToken(32);
    const refreshExpiresAt = new Date(Date.now() + this.sessionTtlMs);
    await this.store.createSession(user.id, await hashToken(refreshToken), refreshExpiresAt, userAgent);
    return { accessToken: await this.accessTokenFor(user, token), refreshToken, refreshExpiresAt, user };
  }

  /** Exchanges a refresh token for a new access token (with freshly computed grants) and rotates it. */
  async refresh(refreshToken: string, token: { audience?: string[]; ttlSeconds?: number } = {}): Promise<IssuedSession> {
    const session = await this.store.findSessionByTokenHash(await hashToken(refreshToken));
    if (!session || session.expiresAt.getTime() < Date.now()) throw AppError.unauthenticated('Session expired');
    const user = await this.store.findUserById(session.userId);
    if (!user?.active) {
      await this.store.revokeSession(session.id);
      throw AppError.unauthenticated('Account disabled');
    }
    const next = randomToken(32);
    await this.store.rotateSession(session.id, await hashToken(next), session.expiresAt);
    return { accessToken: await this.accessTokenFor(user, token), refreshToken: next, refreshExpiresAt: session.expiresAt, user };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const session = await this.store.findSessionByTokenHash(await hashToken(refreshToken));
    if (session) await this.store.revokeSession(session.id);
  }

  sessions(userId: string): Promise<SignedInSession[]> {
    return this.store.listSessions(userId);
  }

  /** Its refresh token stops working at once; access tokens already issued run out within their lifetime. */
  async endSession(userId: string, id: string): Promise<void> {
    if (!(await this.store.revokeOwnSession(userId, id))) throw AppError.notFound('Session');
  }

  async me(userId: string): Promise<Me> {
    const user = await this.store.findUserById(userId);
    if (!user?.active) throw AppError.unauthenticated();
    return {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      isAdmin: isAdministrator(user),
      grants: await this.store.effectiveGrants(user.id),
      units: await this.store.userUnits(user.id),
      preferences: user.preferences,
      source: user.source,
    };
  }

  private async establish(identity: ExternalIdentity, userAgent: string | null): Promise<IssuedSession> {
    // Where the person sits under the directory import's rule: their unit follows them at every sign-in.
    const org = await orgTagFor(this.store, identity);
    if (org) identity = { ...identity, tags: [...identity.tags, org] };
    const user = await this.store.transaction(async (tx) => {
      const u = await tx.upsertUserFromIdentity(identity);
      if (identity.source !== 'local') {
        await tx.syncExternalGroups(u.id, identity.source, identity.groups);
        // Directory groups and attributes decide which teams/divisions the person belongs to.
        const changed = await tx.syncUserDirectory(u.id);
        if (changed.length) await tx.publishUnitChanged(changed);
      }
      await tx.touchLogin(u.id);
      await tx.publishUserChanged(u);
      return u;
    });
    if (!user.active) throw AppError.forbidden('This account has been disabled');
    const refreshToken = randomToken(32);
    const refreshExpiresAt = new Date(Date.now() + this.sessionTtlMs);
    await this.store.createSession(user.id, await hashToken(refreshToken), refreshExpiresAt, userAgent);
    return { accessToken: await this.accessTokenFor(user), refreshToken, refreshExpiresAt, user };
  }

  private async accessTokenFor(user: UserRecord, opts: { audience?: string[]; ttlSeconds?: number } = {}): Promise<string> {
    return this.tokens.issueAccessToken(
      {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      isAdmin: isAdministrator(user),
      grants: await this.store.effectiveGrants(user.id),
      units: await this.store.userUnits(user.id),
      },
      opts,
    );
  }
}
