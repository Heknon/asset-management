import { createTokenVerifier, defineService, registerBackup, type BaseConfig } from '@am/platform';
import { importJWK, type CryptoKey } from 'jose';
import { AccessService } from './application/access-service.js';
import { AuthService } from './application/auth-service.js';
import { DirectoryService } from './application/directory-service.js';
import { OrgService } from './application/org-service.js';
import type { DirectoryCrawler, PasswordProvider, RedirectProvider } from './application/ports.js';
import { DirectoryImportService } from './application/directory-import.js';
import { GoogleSignIn, type GoogleClient } from './application/google-sign-in.js';
import { identityConfig, signInMethods } from './config.js';
import { normalizeUsername } from './domain/model.js';
import { JwtIssuer, ScryptHasher, type ScryptFn } from './infrastructure/crypto.js';
import { PgIdentityStore } from './infrastructure/pg-identity-store.js';
import { LocalPasswordProvider } from './infrastructure/local-provider.js';
import { migrations, type IdentityDB } from './infrastructure/schema.js';
import { registerRoutes } from './http/routes.js';
import { registerOAuthRoutes } from './http/oauth-routes.js';
import { OAuthService } from './application/oauth-service.js';
import { PgOAuthStore } from './infrastructure/pg-oauth-store.js';
import type { Logger } from 'pino';
import type { z } from 'zod';

export type IdentityConfig = BaseConfig & z.infer<z.ZodObject<typeof identityConfig>>;

/** Directory sign-in (LDAP / ADFS) and the scrypt implementation: Node-only on the server; the browser runtime has local accounts only. */
export interface IdentityAdapters {
  scrypt: ScryptFn;
  directories?(config: IdentityConfig, logger: Logger): { passwords: Map<string, PasswordProvider>; redirect: RedirectProvider | null; crawler?: DirectoryCrawler | null };
  /** Google's OpenID Connect client (server and serverless only). */
  google?(clientId: string, clientSecret: string): GoogleClient;
}

/** People, groups, the organization tree, access grants, sign-in and tokens. */
export const defineIdentityService = (adapters: IdentityAdapters) => {
  let issuer: JwtIssuer;
  return defineService<IdentityDB, typeof identityConfig>({
    name: 'identity',
    config: identityConfig,
    migrations,
    // Identity verifies its own tokens with its own key instead of fetching JWKS from itself.
    verifier: async ({ config }) => {
      issuer = await JwtIssuer.create(config.AUTH_SIGNING_KEY, {
        issuer: config.AUTH_ISSUER,
        audience: config.AUTH_AUDIENCE,
        ttlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
        allowEphemeral: config.NODE_ENV !== 'production',
      });
      return createTokenVerifier((await importJWK(issuer.publicKey, 'ES256')) as CryptoKey, { issuer: config.AUTH_ISSUER, audience: config.AUTH_AUDIENCE });
    },
    async register({ config, database, app, bus, logger }) {
      const store = new PgIdentityStore(database.db);
      const hasher = new ScryptHasher(adapters.scrypt);

      const directories = adapters.directories?.(config, logger) ?? { passwords: new Map<string, PasswordProvider>(), redirect: null };
      const passwordProviders = directories.passwords;
      if (signInMethods(config).manual) passwordProviders.set('local', new LocalPasswordProvider(store, hasher));
      const oidc = directories.redirect;
      const google = signInMethods(config).google ? googleSignIn(config, adapters) : null;

      await bootstrapLocalAdmin(store, hasher, config.LOCAL_ADMIN_USERNAME, config.LOCAL_ADMIN_PASSWORD, config.LOCAL_ADMIN_EMAIL);

      const auth = new AuthService(store, issuer, passwordProviders, oidc, config.SESSION_TTL_HOURS * 3_600_000, !!google);
      const publicUrl = config.PUBLIC_URL.replace(/\/$/, '');
      // MCP clients sign people in here: they register, the person accepts on /oauth/authorize, they get tokens.
      registerOAuthRoutes(app, new OAuthService(new PgOAuthStore(database.db), auth, publicUrl));
      const org = new OrgService(store);
      registerRoutes(app, {
        auth,
        directory: new DirectoryService(store, hasher, !!google),
        org,
        directoryImport: new DirectoryImportService(store, org, directories.crawler ?? null, config.LDAP_CRAWL_LIMIT),
        access: new AccessService(store),
        jwks: () => issuer.jwks(),
        publicUrl,
        secureCookies: config.COOKIE_SECURE,
        accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
        google,
      });

      await registerBackup(app, {
        name: 'identity',
        database,
        logger,
        bus,
        enabled: config.BACKUP_ENABLED,
        rules: {
          // A restore signs everyone out: sessions and sign-in codes of the replaced data mean nothing afterwards.
          transient: ['sessions', 'oauth_codes'],
          // The backup may predate the break-glass administrator, or carry an older password for it.
          afterRestore: () => bootstrapLocalAdmin(store, hasher, config.LOCAL_ADMIN_USERNAME, config.LOCAL_ADMIN_PASSWORD, config.LOCAL_ADMIN_EMAIL),
        },
      });

      // Hourly on the server; on each cron run when serverless.
      await bus.schedule('identity.purge-sessions', '7 * * * *', () => store.purgeExpiredSessions());
      logger.info({ providers: auth.providers().map((p) => p.id) }, 'identity providers enabled');
    },
  });
};

/** Google sign-in from configuration: the OAuth client, this deployment's origin and the state secret. */
function googleSignIn(config: IdentityConfig, adapters: IdentityAdapters): GoogleSignIn {
  if (!adapters.google) throw new Error('Google sign-in is not available in this runtime');
  if (!config.AUTH_GOOGLE_ID || !config.AUTH_GOOGLE_SECRET) throw new Error('Google sign-in needs AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET');
  if (config.AUTH_REDIRECT_PROXY_URL && !config.AUTH_SECRET) throw new Error('AUTH_REDIRECT_PROXY_URL needs AUTH_SECRET, shared with the proxy');
  return new GoogleSignIn({
    client: adapters.google(config.AUTH_GOOGLE_ID, config.AUTH_GOOGLE_SECRET),
    origin: config.AUTH_URL ?? config.PUBLIC_URL,
    secret: config.AUTH_SECRET ?? config.COOKIE_SECRET,
    proxyUrl: config.AUTH_REDIRECT_PROXY_URL,
    previewHostSuffix: config.AUTH_PREVIEW_HOST_SUFFIX,
  });
}

/** Creates (or re-keys) the break-glass administrator from configuration. */
async function bootstrapLocalAdmin(store: PgIdentityStore, hasher: ScryptHasher, username?: string, password?: string, email?: string) {
  if (!username || !password) return;
  const name = normalizeUsername(username);
  const existing = await store.findUserByUsername(name, 'local');
  if (!existing) {
    await store.transaction(async (tx) => {
      const user = await tx.createLocalUser({ username: name, displayName: 'Administrator', email: email?.toLowerCase() ?? null, passwordHash: await hasher.hash(password), isAdmin: true });
      await tx.publishUserChanged(user);
    });
    return;
  }
  const hash = await store.getPasswordHash(existing.id);
  if (!hash || !(await hasher.verify(password, hash))) await store.setPasswordHash(existing.id, await hasher.hash(password));
  if (email && existing.email !== email.toLowerCase()) await store.setEmail(existing.id, email.toLowerCase());
}
