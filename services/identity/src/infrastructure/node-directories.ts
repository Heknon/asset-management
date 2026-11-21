import type { Logger } from 'pino';
import type { DirectoryCrawler, PasswordProvider, RedirectProvider } from '../application/ports.js';
import { signInMethods } from '../config.js';
import type { IdentityConfig } from '../service.js';
import { LdapCrawler, LdapPasswordProvider, OidcRedirectProvider } from './providers.js';

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when its provider is enabled`);
  return value;
}

/** LDAP and ADFS sign-in for Node (the server and serverless runtimes), as AUTH_MODE or the per-method switches say. */
export function nodeDirectories(config: IdentityConfig, logger: Logger): { passwords: Map<string, PasswordProvider>; redirect: RedirectProvider | null; crawler: DirectoryCrawler | null } {
  const methods = signInMethods(config);
  const passwordProviders = new Map<string, PasswordProvider>();
  let crawler: DirectoryCrawler | null = null;
  if (methods.ldap) {
    const settings = {
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
      nameAttributes: config.LDAP_NAME_ATTRIBUTES,
      emailAttribute: config.LDAP_EMAIL_ATTRIBUTE,
      membershipAttribute: config.LDAP_GROUP_MEMBERSHIP_ATTRIBUTE,
      groupBaseDn: config.LDAP_GROUP_BASE_DN,
      groupFilter: config.LDAP_GROUP_FILTER,
      adminGroups: config.LDAP_ADMIN_GROUPS,
      unitAttributes: config.LDAP_UNIT_ATTRIBUTES,
      crawlFilter: config.LDAP_CRAWL_FILTER,
      managerAttribute: config.LDAP_MANAGER_ATTRIBUTE,
    };
    passwordProviders.set('ldap', new LdapPasswordProvider(settings, logger));
    crawler = new LdapCrawler(settings, logger);
  }

  const oidc = methods.adfs
    ? new OidcRedirectProvider({
        label: config.OIDC_LABEL,
        issuer: need(config.OIDC_ISSUER, 'OIDC_ISSUER'),
        clientId: need(config.OIDC_CLIENT_ID, 'OIDC_CLIENT_ID'),
        clientSecret: need(config.OIDC_CLIENT_SECRET, 'OIDC_CLIENT_SECRET'),
        scopes: config.OIDC_SCOPES,
        usernameClaim: config.OIDC_USERNAME_CLAIM,
        displayNameClaim: config.OIDC_DISPLAY_NAME_CLAIM,
        nameClaims: config.OIDC_NAME_CLAIMS,
        emailClaim: config.OIDC_EMAIL_CLAIM,
        groupsClaim: config.OIDC_GROUPS_CLAIM,
        adminGroups: config.OIDC_ADMIN_GROUPS,
        unitClaims: config.OIDC_UNIT_CLAIMS,
      })
    : null;
  return { passwords: passwordProviders, redirect: oidc, crawler };
}
