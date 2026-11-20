import { describe, expect, it } from 'bun:test';
import { GoogleSignIn, isAllowedReturnOrigin, signState, verifyState, type GoogleClient } from './google-sign-in.js';

const SECRET = 'a-shared-non-production-auth-secret-0123456789';
const DEV = 'https://dev.assets.test';
const PROXY = `${DEV}/api/auth`;
const PREVIEW = 'https://assets-git-feature-team.vercel.app';
const SUFFIX = '-team.vercel.app';

describe('signed state', () => {
  const state = { origin: PREVIEW, nonce: 'n1', exp: 2_000 };

  it('round-trips with the same secret', async () => {
    expect(await verifyState(await signState(state, SECRET), SECRET, 1_000)).toEqual(state);
  });

  it('refuses another secret, a changed payload and an expired state', async () => {
    const signed = await signState(state, SECRET);
    expect(await verifyState(signed, 'another-secret-of-at-least-32-characters', 1_000)).toBeNull();
    const [, signature] = signed.split('.');
    const forged = Buffer.from(JSON.stringify({ ...state, origin: 'https://evil.example' })).toString('base64url');
    expect(await verifyState(`${forged}.${signature}`, SECRET, 1_000)).toBeNull();
    expect(await verifyState(signed, SECRET, 3_000)).toBeNull();
  });

  it('refuses malformed values', async () => {
    for (const v of ['', 'x', 'a.b.c', '!!.??']) expect(await verifyState(v, SECRET)).toBeNull();
  });
});

describe('isAllowedReturnOrigin', () => {
  const opts = { trusted: [DEV, PROXY], previewHostSuffix: SUFFIX };

  it("accepts the dev domain, the team's previews and localhost", () => {
    for (const o of [DEV, PREVIEW, 'https://assets-abc123-team.vercel.app', 'http://localhost:5173', 'http://127.0.0.1:3000']) expect(isAllowedReturnOrigin(o, opts)).toBe(true);
  });

  it('refuses other teams, look-alike hosts, paths and plain http', () => {
    for (const o of [
      'https://assets-git-x-otherteam.vercel.app',
      'https://team.vercel.app',
      'https://-team.vercel.app.evil.example',
      'https://a.b-team.vercel.app',
      'http://assets-git-feature-team.vercel.app',
      'https://assets-git-feature-team.vercel.app:8443',
      `${PREVIEW}/path`,
      'https://evil.example',
      'javascript:alert(1)',
      'not a url',
    ]) expect(isAllowedReturnOrigin(o, opts)).toBe(false);
  });

  it('accepts no previews without a suffix', () => {
    expect(isAllowedReturnOrigin(PREVIEW, { trusted: [DEV] })).toBe(false);
  });
});

class FakeGoogle implements GoogleClient {
  exchanged: { url: string; codeVerifier: string } | null = null;
  constructor(private readonly claims: { email?: unknown; email_verified?: unknown } = { email: 'Dana@Corp.test', email_verified: true }) {}
  async authorizationUrl(p: { redirectUri: string; state: string }) {
    return `https://accounts.google.test/auth?${new URLSearchParams({ redirect_uri: p.redirectUri, state: p.state })}`;
  }
  async exchange(callbackUrl: URL, checks: { codeVerifier: string }) {
    this.exchanged = { url: callbackUrl.href, codeVerifier: checks.codeVerifier };
    return this.claims;
  }
}

const googleReturn = (authUrl: string) => {
  const state = new URL(authUrl).searchParams.get('state')!;
  return new URLSearchParams({ state, code: 'the-code', scope: 'openid email' }).toString();
};

describe('GoogleSignIn through the dev proxy', () => {
  it('sends Google to the proxy, which forwards to the preview, which exchanges with the proxy redirect URI', async () => {
    const previewClient = new FakeGoogle();
    const preview = new GoogleSignIn({ client: previewClient, origin: PREVIEW, secret: SECRET, proxyUrl: PROXY });
    const dev = new GoogleSignIn({ client: new FakeGoogle(), origin: DEV, secret: SECRET, proxyUrl: PROXY, previewHostSuffix: SUFFIX });

    const { url, cookie } = await preview.begin('/assets');
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(`${PROXY}/callback/google`);

    const query = googleReturn(url);
    const forwarded = await dev.callback(query, null);
    expect(forwarded).toEqual({ kind: 'forward', location: `${PREVIEW}/api/auth/callback/google?${query}` });

    const done = await preview.callback(new URL(forwarded.kind === 'forward' ? forwarded.location : '').search, cookie);
    expect(done).toEqual({ kind: 'signed-in', email: 'dana@corp.test', returnTo: '/assets' });
    expect(previewClient.exchanged?.url.startsWith(`${PROXY}/callback/google?`)).toBe(true);
    expect(previewClient.exchanged?.codeVerifier).toBe(cookie.codeVerifier);
  });

  it("returns a preview opened at its deployment URL to that URL, and ignores hosts it doesn't serve", async () => {
    const deployment = 'https://assets-abc123-team.vercel.app';
    const preview = new GoogleSignIn({ client: new FakeGoogle(), origin: PREVIEW, secret: SECRET, proxyUrl: PROXY, previewHostSuffix: SUFFIX });
    const dev = new GoogleSignIn({ client: new FakeGoogle(), origin: DEV, secret: SECRET, proxyUrl: PROXY, previewHostSuffix: SUFFIX });
    const { url, cookie } = await preview.begin('/', deployment);
    const forwarded = await dev.callback(googleReturn(url), null, DEV);
    expect(forwarded.kind === 'forward' && forwarded.location.startsWith(`${deployment}/api/auth/callback/google?`)).toBe(true);
    expect(await preview.callback(googleReturn(url), cookie, deployment)).toMatchObject({ kind: 'signed-in' });

    const spoofed = await preview.begin('/', 'https://evil.example');
    expect(await dev.callback(googleReturn(spoofed.url), null, DEV)).toEqual({ kind: 'forward', location: `${PREVIEW}/api/auth/callback/google?${googleReturn(spoofed.url)}` });
  });

  it('signs in on the dev deployment itself without forwarding', async () => {
    const dev = new GoogleSignIn({ client: new FakeGoogle(), origin: DEV, secret: SECRET, proxyUrl: PROXY, previewHostSuffix: SUFFIX });
    const { url, cookie } = await dev.begin('/');
    expect(await dev.callback(googleReturn(url), cookie)).toMatchObject({ kind: 'signed-in' });
  });

  it('uses its own callback without a proxy', async () => {
    const prod = new GoogleSignIn({ client: new FakeGoogle(), origin: 'https://assets.test', secret: SECRET });
    const { url } = await prod.begin('/');
    expect(new URL(url).searchParams.get('redirect_uri')).toBe('https://assets.test/api/auth/callback/google');
  });

  it('refuses to forward to an origin outside the allow-list, even with a valid signature', async () => {
    const outsider = new GoogleSignIn({ client: new FakeGoogle(), origin: 'https://assets-git-x-otherteam.vercel.app', secret: SECRET, proxyUrl: PROXY });
    const dev = new GoogleSignIn({ client: new FakeGoogle(), origin: DEV, secret: SECRET, proxyUrl: PROXY, previewHostSuffix: SUFFIX });
    const { url } = await outsider.begin('/');
    await expect(dev.callback(googleReturn(url), null)).rejects.toThrow('does not serve');
  });

  it('only the proxy forwards', async () => {
    const preview = new GoogleSignIn({ client: new FakeGoogle(), origin: PREVIEW, secret: SECRET, proxyUrl: PROXY });
    const other = new GoogleSignIn({ client: new FakeGoogle(), origin: 'https://assets-git-y-team.vercel.app', secret: SECRET, proxyUrl: PROXY, previewHostSuffix: SUFFIX });
    const { url } = await preview.begin('/');
    await expect(other.callback(googleReturn(url), null)).rejects.toThrow('does not serve');
  });

  it('refuses a state signed with another secret', async () => {
    const preview = new GoogleSignIn({ client: new FakeGoogle(), origin: PREVIEW, secret: 'a-different-secret-that-is-long-enough-000', proxyUrl: PROXY });
    const dev = new GoogleSignIn({ client: new FakeGoogle(), origin: DEV, secret: SECRET, proxyUrl: PROXY, previewHostSuffix: SUFFIX });
    const { url } = await preview.begin('/');
    await expect(dev.callback(googleReturn(url), null)).rejects.toThrow('Sign-in expired');
  });

  it('refuses a callback without the browser cookie that started it', async () => {
    const dev = new GoogleSignIn({ client: new FakeGoogle(), origin: DEV, secret: SECRET });
    const first = await dev.begin('/');
    const second = await dev.begin('/');
    await expect(dev.callback(googleReturn(first.url), null)).rejects.toThrow('Sign-in expired');
    await expect(dev.callback(googleReturn(first.url), second.cookie)).rejects.toThrow('Sign-in expired');
  });

  it('accepts verified emails only', async () => {
    for (const claims of [{ email: 'dana@corp.test', email_verified: false }, { email: 'dana@corp.test' }, { email_verified: true }]) {
      const dev = new GoogleSignIn({ client: new FakeGoogle(claims), origin: DEV, secret: SECRET });
      const { url, cookie } = await dev.begin('/');
      await expect(dev.callback(googleReturn(url), cookie)).rejects.toThrow('did not confirm');
    }
  });
});
