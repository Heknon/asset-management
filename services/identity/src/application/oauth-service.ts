import { AppError } from '@am/core';
import { randomToken, sha256Hex, toBase64Url } from '@am/platform';
import type { AuthService } from './auth-service.js';

/**
 * OAuth 2.1 for MCP clients (and any other OAuth client): they register
 * themselves, send the person to the app's accept screen, and swap the code
 * (with PKCE) for tokens that act as that person — with exactly the access the
 * person has. Every client gets its own session, revoked like any other.
 */
export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
}

export interface OAuthCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scope: string | null;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface OAuthStore {
  createClient(client: OAuthClient): Promise<void>;
  findClient(id: string): Promise<OAuthClient | null>;
  createCode(codeHash: string, code: Omit<OAuthCode, 'usedAt'>): Promise<void>;
  /** Marks the code used and returns it, unless it was used already. */
  consumeCode(codeHash: string): Promise<OAuthCode | null>;
}

/** The parameters of an authorization request, as sent to the authorization endpoint. */
export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

const CODE_TTL_MS = 2 * 60_000;
/** One hour; clients use their refresh token for more. */
const ACCESS_TTL_SECONDS = 3600;

/** Redirects go to https, or to the person's own machine (desktop MCP clients listen on localhost). */
function acceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    // Native apps' private schemes (e.g. cursor://, vscode://).
    return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:'].includes(u.protocol);
  } catch {
    return false;
  }
}

export class OAuthService {
  constructor(
    private readonly store: OAuthStore,
    private readonly auth: AuthService,
    /** The app's public URL: the issuer, and the base of the MCP resource. */
    private readonly publicUrl: string,
  ) {}

  get issuer() {
    return this.publicUrl;
  }

  /** The MCP server, which the tokens are issued for. */
  get mcpResource() {
    return `${this.publicUrl}/mcp`;
  }

  /** RFC 8414 authorization server metadata. */
  metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.publicUrl}/oauth/authorize`,
      token_endpoint: `${this.publicUrl}/api/identity/oauth/token`,
      registration_endpoint: `${this.publicUrl}/api/identity/oauth/register`,
      revocation_endpoint: `${this.publicUrl}/api/identity/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['assets'],
      service_documentation: `${this.publicUrl}/`,
    };
  }

  /** RFC 7591 dynamic registration: open, as MCP clients expect; people still approve each client. */
  async register(input: { client_name?: unknown; redirect_uris?: unknown }) {
    const redirectUris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!redirectUris.length || redirectUris.length > 10) throw oauthError('invalid_redirect_uri', 'Give one to ten redirect_uris');
    const bad = redirectUris.find((u) => !acceptableRedirect(u) || u.length > 2000);
    if (bad) throw oauthError('invalid_redirect_uri', `Redirect URIs must be https, or http on localhost: ${bad}`);
    const name = (typeof input.client_name === 'string' ? input.client_name.trim() : '').slice(0, 100) || new URL(redirectUris[0]!).host || 'An MCP client';
    const client: OAuthClient = { id: `mcp_${randomToken(16)}`, name, redirectUris };
    await this.store.createClient(client);
    return {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  /** Checks an authorization request and says who is asking (for the accept screen). */
  async describe(params: AuthorizeParams) {
    const client = await this.checkRequest(params);
    return {
      client: { id: client.id, name: client.name },
      redirectHost: new URL(params.redirect_uri!).host || params.redirect_uri!,
      resource: params.resource ?? this.mcpResource,
    };
  }

  /** The person accepted (or refused): where to send the browser back to. */
  async decide(userId: string, params: AuthorizeParams, accept: boolean): Promise<{ redirectTo: string }> {
    await this.checkRequest(params);
    const back = new URL(params.redirect_uri!);
    if (params.state) back.searchParams.set('state', params.state);
    back.searchParams.set('iss', this.issuer);
    if (!accept) {
      back.searchParams.set('error', 'access_denied');
      return { redirectTo: back.toString() };
    }
    const code = randomToken(32);
    await this.store.createCode(await sha256Hex(code), {
      clientId: params.client_id!,
      userId,
      redirectUri: params.redirect_uri!,
      codeChallenge: params.code_challenge!,
      resource: params.resource ?? null,
      scope: params.scope ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    back.searchParams.set('code', code);
    return { redirectTo: back.toString() };
  }

  /** The token endpoint: a code (with its PKCE verifier) or a refresh token for tokens. */
  async token(form: Record<string, string | undefined>) {
    if (form.grant_type === 'authorization_code') {
      if (!form.code || !form.code_verifier || !form.client_id || !form.redirect_uri) throw oauthError('invalid_request', 'code, code_verifier, client_id and redirect_uri are required');
      const code = await this.store.consumeCode(await sha256Hex(form.code));
      if (!code || code.expiresAt.getTime() < Date.now()) throw oauthError('invalid_grant', 'The code is unknown, used or expired');
      if (code.clientId !== form.client_id || code.redirectUri !== form.redirect_uri) throw oauthError('invalid_grant', 'The code was issued to another client or redirect URI');
      if ((await pkceChallenge(form.code_verifier)) !== code.codeChallenge) throw oauthError('invalid_grant', 'The code verifier does not match');
      const client = await this.store.findClient(code.clientId);
      const session = await this.auth.sessionFor(code.userId, `${client?.name ?? 'MCP client'} (connected app)`, this.tokenOptions(code.resource));
      return this.tokenResponse(session, code.scope);
    }
    if (form.grant_type === 'refresh_token') {
      if (!form.refresh_token) throw oauthError('invalid_request', 'refresh_token is required');
      const session = await this.auth.refresh(form.refresh_token, this.tokenOptions(form.resource ?? null)).catch(() => {
        throw oauthError('invalid_grant', 'The refresh token is unknown, revoked or expired');
      });
      return this.tokenResponse(session, form.scope ?? null);
    }
    throw oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
  }

  /** RFC 7009: revoking a refresh token ends that client's session. */
  async revoke(token: string | undefined) {
    if (token) await this.auth.logout(token).catch(() => undefined);
  }

  private tokenOptions(resource: string | null) {
    // Tokens always name the MCP server (and the services); a requested resource must be it.
    if (resource && resource.replace(/\/$/, '') !== this.mcpResource) throw oauthError('invalid_target', `Tokens are only issued for ${this.mcpResource}`);
    return { audience: [this.mcpResource], ttlSeconds: ACCESS_TTL_SECONDS };
  }

  private tokenResponse(session: { accessToken: string; refreshToken: string }, scope: string | null) {
    return { access_token: session.accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: session.refreshToken, scope: scope ?? 'assets' };
  }

  private async checkRequest(params: AuthorizeParams): Promise<OAuthClient> {
    if (params.response_type !== 'code') throw oauthError('unsupported_response_type', 'response_type must be code');
    const client = params.client_id ? await this.store.findClient(params.client_id) : null;
    if (!client) throw oauthError('invalid_client', 'Unknown client: register it first');
    if (!params.redirect_uri || !client.redirectUris.includes(params.redirect_uri)) throw oauthError('invalid_request', 'redirect_uri is not one the client registered');
    if (!params.code_challenge || params.code_challenge_method !== 'S256') throw oauthError('invalid_request', 'PKCE with S256 is required');
    if (params.resource && params.resource.replace(/\/$/, '') !== this.mcpResource) throw oauthError('invalid_target', `Tokens are only issued for ${this.mcpResource}`);
    return client;
  }
}

/** base64url(SHA-256(verifier)), as in RFC 7636. */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/** OAuth errors carry their RFC code; routes render them as `{ error, error_description }`. */
export function oauthError(code: string, description: string): AppError {
  return AppError.validation(description, { oauth: code });
}
