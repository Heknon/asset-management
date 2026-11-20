import * as oidc from 'openid-client';
import type { GoogleClient } from '../application/google-sign-in.js';

const GOOGLE_ISSUER = 'https://accounts.google.com';

/** Google's OpenID Connect endpoints, discovered on first use (and retried after a failure). */
export class OidcGoogleClient implements GoogleClient {
  private config: Promise<oidc.Configuration> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private configuration(): Promise<oidc.Configuration> {
    this.config ??= oidc.discovery(new URL(GOOGLE_ISSUER), this.clientId, this.clientSecret).catch((err) => {
      this.config = null;
      throw err;
    });
    return this.config;
  }

  async authorizationUrl(p: { redirectUri: string; state: string; nonce: string; codeChallenge: string }): Promise<string> {
    return oidc.buildAuthorizationUrl(await this.configuration(), {
      redirect_uri: p.redirectUri,
      scope: 'openid email profile',
      response_type: 'code',
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).href;
  }

  async exchange(callbackUrl: URL, checks: { state: string; nonce: string; codeVerifier: string }) {
    const tokens = await oidc.authorizationCodeGrant(await this.configuration(), callbackUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    return tokens.claims() ?? {};
  }
}
