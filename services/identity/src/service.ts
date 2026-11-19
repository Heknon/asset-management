import { createTokenVerifier, defineService, type BaseConfig } from '@am/platform';
import { importJWK, type CryptoKey } from 'jose';
import { AccessService } from './application/access-service.js';
import { AuthService } from './application/auth-service.js';
import { DirectoryService } from './application/directory-service.js';
import { OrgService } from './application/org-service.js';
import type { PasswordProvider, RedirectProvider } from './application/ports.js';
import { identityConfig } from './config.js';
import { normalizeUsername } from './domain/model.js';
import { JwtIssuer, ScryptHasher, type ScryptFn } from './infrastructure/crypto.js';
import { PgIdentityStore } from './infrastructure/pg-identity-store.js';
import { LocalPasswordProvider } from './infrastructure/local-provider.js';
import { migrations, type IdentityDB } from './infrastructure/schema.js';
import { registerRoutes } from './http/routes.js';
import type { Logger } from 'pino';
import type { z } from 'zod';

export type IdentityConfig = BaseConfig & z.infer<z.ZodObject<typeof identityConfig>>;

/** Directory sign-in (LDAP / ADFS) and the scrypt implementation: Node-only on the server; the browser runtime has local accounts only. */
export interface IdentityAdapters {
  scrypt: ScryptFn;
  directories?(config: IdentityConfig, logger: Logger): { passwords: Map<string, PasswordProvider>; redirect: RedirectProvider | null };
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
    async register({ config, database, app, logger, onClose }) {
      const store = new PgIdentityStore(database.db);
      const hasher = new ScryptHasher(adapters.scrypt);

      const directories = adapters.directories?.(config, logger) ?? { passwords: new Map<string, PasswordProvider>(), redirect: null };
      const passwordProviders = directories.passwords;
      if (config.LOCAL_AUTH_ENABLED) passwordProviders.set('local', new LocalPasswordProvider(store, hasher));
      const oidc = directories.redirect;

      await bootstrapLocalAdmin(store, hasher, config.LOCAL_ADMIN_USERNAME, config.LOCAL_ADMIN_PASSWORD);

      const auth = new AuthService(store, issuer, passwordProviders, oidc, config.SESSION_TTL_HOURS * 3_600_000);
      registerRoutes(app, {
        auth,
        directory: new DirectoryService(store, hasher),
        org: new OrgService(store),
        access: new AccessService(store),
        jwks: () => issuer.jwks(),
        publicUrl: config.PUBLIC_URL.replace(/\/$/, ''),
        secureCookies: config.COOKIE_SECURE,
        accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
      });

      const purge = setInterval(() => void store.purgeExpiredSessions().catch((err) => logger.warn({ err }, 'session purge failed')), 3_600_000);
      onClose(() => clearInterval(purge));
      logger.info({ providers: auth.providers().map((p) => p.id) }, 'identity providers enabled');
    },
  });
};

/** Creates (or re-keys) the break-glass administrator from configuration. */
async function bootstrapLocalAdmin(store: PgIdentityStore, hasher: ScryptHasher, username?: string, password?: string) {
  if (!username || !password) return;
  const name = normalizeUsername(username);
  const existing = await store.findUserByUsername(name, 'local');
  if (!existing) {
    await store.transaction(async (tx) => {
      const user = await tx.createLocalUser({ username: name, displayName: 'Administrator', email: null, passwordHash: await hasher.hash(password), isAdmin: true });
      await tx.publishUserChanged(user);
    });
    return;
  }
  const hash = await store.getPasswordHash(existing.id);
  if (!hash || !(await hasher.verify(password, hash))) await store.setPasswordHash(existing.id, await hasher.hash(password));
}
