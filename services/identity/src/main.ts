import { createTokenVerifier, main, runService } from '@am/platform';
import { importJWK, type CryptoKey } from 'jose';
import { AccessService } from './application/access-service.js';
import { AuthService } from './application/auth-service.js';
import { DirectoryService } from './application/directory-service.js';
import { OrgService } from './application/org-service.js';
import type { PasswordProvider } from './application/ports.js';
import { identityConfig } from './config.js';
import { normalizeUsername } from './domain/model.js';
import { JwtIssuer, ScryptHasher } from './infrastructure/crypto.js';
import { PgIdentityStore } from './infrastructure/pg-identity-store.js';
import { LdapPasswordProvider, LocalPasswordProvider, OidcRedirectProvider } from './infrastructure/providers.js';
import { migrations, type IdentityDB } from './infrastructure/schema.js';
import { registerRoutes } from './http/routes.js';

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when its provider is enabled`);
  return value;
}

let issuer: JwtIssuer;

main(() =>
  runService<IdentityDB, typeof identityConfig>({
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
      const hasher = new ScryptHasher();

      const passwordProviders = new Map<string, PasswordProvider>();
      if (config.LDAP_ENABLED) {
        passwordProviders.set(
          'ldap',
          new LdapPasswordProvider(
            {
              label: config.LDAP_LABEL,
              url: need(config.LDAP_URL, 'LDAP_URL'),
              startTls: config.LDAP_STARTTLS,
              caCert: config.LDAP_CA_CERT,
              bindDn: need(config.LDAP_BIND_DN, 'LDAP_BIND_DN'),
              bindPassword: need(config.LDAP_BIND_PASSWORD, 'LDAP_BIND_PASSWORD'),
              userBaseDn: need(config.LDAP_USER_BASE_DN, 'LDAP_USER_BASE_DN'),
              userFilter: config.LDAP_USER_FILTER,
              usernameAttribute: config.LDAP_USERNAME_ATTRIBUTE,
              displayNameAttribute: config.LDAP_DISPLAY_NAME_ATTRIBUTE,
              emailAttribute: config.LDAP_EMAIL_ATTRIBUTE,
              membershipAttribute: config.LDAP_GROUP_MEMBERSHIP_ATTRIBUTE,
              groupBaseDn: config.LDAP_GROUP_BASE_DN,
              groupFilter: config.LDAP_GROUP_FILTER,
              adminGroups: config.LDAP_ADMIN_GROUPS,
              unitAttributes: config.LDAP_UNIT_ATTRIBUTES,
            },
            logger,
          ),
        );
      }
      if (config.LOCAL_AUTH_ENABLED) passwordProviders.set('local', new LocalPasswordProvider(store, hasher));

      const oidc = config.OIDC_ENABLED
        ? new OidcRedirectProvider({
            label: config.OIDC_LABEL,
            issuer: need(config.OIDC_ISSUER, 'OIDC_ISSUER'),
            clientId: need(config.OIDC_CLIENT_ID, 'OIDC_CLIENT_ID'),
            clientSecret: need(config.OIDC_CLIENT_SECRET, 'OIDC_CLIENT_SECRET'),
            scopes: config.OIDC_SCOPES,
            usernameClaim: config.OIDC_USERNAME_CLAIM,
            displayNameClaim: config.OIDC_DISPLAY_NAME_CLAIM,
            emailClaim: config.OIDC_EMAIL_CLAIM,
            groupsClaim: config.OIDC_GROUPS_CLAIM,
            adminGroups: config.OIDC_ADMIN_GROUPS,
            unitClaims: config.OIDC_UNIT_CLAIMS,
          })
        : null;

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
  }),
);

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
