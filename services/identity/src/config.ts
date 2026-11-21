import { envBool, envList } from '@am/platform';
import { z } from 'zod';

export const identityConfig = {
  /** PKCS#8 PEM EC P-256 key used to sign access tokens. Generated per process in development only. */
  AUTH_SIGNING_KEY: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  COOKIE_SECRET: z.string().min(32),
  COOKIE_SECURE: envBool(true),

  /**
   * Which sign-in methods are on, in one setting: any of `manual` (accounts and passwords kept here,
   * created by admins), `ldap` and `adfs`, comma-separated, e.g. `manual` or `ldap,adfs`.
   * Unset: LOCAL_AUTH_ENABLED, LDAP_ENABLED and OIDC_ENABLED decide, as before.
   */
  AUTH_MODE: z
    .string()
    .regex(/^\s*(manual|local|ldap|adfs|oidc|google)(\s*[,+ ]\s*(manual|local|ldap|adfs|oidc|google))*\s*$/i, 'AUTH_MODE is a comma-separated list of manual, ldap, adfs and google')
    .optional(),

  /** Break-glass local administrator. Leave unset to disable local login entirely. */
  LOCAL_AUTH_ENABLED: envBool(true),
  LOCAL_ADMIN_USERNAME: z.string().optional(),
  LOCAL_ADMIN_PASSWORD: z.string().min(12).optional(),
  /** The administrator's email, so they can also sign in with Google. */
  LOCAL_ADMIN_EMAIL: z.string().email().optional(),

  /** Google sign-in (AUTH_MODE includes `google`): the OAuth client. Callback: `<origin>/api/auth/callback/google`. */
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  /** Signs the Google `state`; deployments that share a redirect proxy share it. Unset: COOKIE_SECRET. */
  AUTH_SECRET: z.string().min(32).optional(),
  /** This deployment's origin for Google sign-in. Unset: PUBLIC_URL. */
  AUTH_URL: z.string().url().optional(),
  /** Google returns to `<this>/callback/google`, which forwards to the deployment that started sign-in, e.g. `https://dev.example.com/api/auth`. */
  AUTH_REDIRECT_PROXY_URL: z.string().url().optional(),
  /** Hosts ending with this may be return origins through the proxy, e.g. `-team.vercel.app` (set by the serverless runtime). */
  AUTH_PREVIEW_HOST_SUFFIX: z.string().optional(),

  LDAP_ENABLED: envBool(false),
  LDAP_LABEL: z.string().default('Corporate directory'),
  LDAP_URL: z.string().optional(),
  LDAP_STARTTLS: envBool(false),
  LDAP_CA_CERT: z.string().optional(),
  LDAP_BIND_DN: z.string().optional(),
  LDAP_BIND_PASSWORD: z.string().optional(),
  LDAP_USER_BASE_DN: z.string().optional(),
  /** `{username}` is replaced with the RFC 4515-escaped login name. */
  LDAP_USER_FILTER: z.string().default('(&(objectClass=person)(|(sAMAccountName={username})(uid={username})(userPrincipalName={username})))'),
  LDAP_USERNAME_ATTRIBUTE: z.string().default('sAMAccountName'),
  LDAP_DISPLAY_NAME_ATTRIBUTE: z.string().default('displayName'),
  /** Further name attributes people can be searched by (comma-separated); every value is kept. */
  LDAP_NAME_ATTRIBUTES: envList.transform((v) => (v.length ? v : ['givenName', 'sn', 'cn', 'name', 'userPrincipalName'])),
  LDAP_EMAIL_ATTRIBUTE: z.string().default('mail'),
  LDAP_GROUP_MEMBERSHIP_ATTRIBUTE: z.string().default('memberOf'),
  /** Optional group search for directories without memberOf (e.g. OpenLDAP groupOfNames). `{dn}` is the user DN. */
  LDAP_GROUP_BASE_DN: z.string().optional(),
  LDAP_GROUP_FILTER: z.string().default('(|(member={dn})(uniqueMember={dn}))'),
  LDAP_ADMIN_GROUPS: envList,
  /** User attributes that place people in units, matched as `attribute=value`, e.g. department,division. */
  LDAP_UNIT_ATTRIBUTES: envList,
  /** The directory import reads everyone this filter matches under LDAP_USER_BASE_DN: people, not computers. */
  LDAP_CRAWL_FILTER: z.string().default('(|(objectClass=inetOrgPerson)(&(objectCategory=person)(objectClass=user)))'),
  LDAP_MANAGER_ATTRIBUTE: z.string().default('manager'),
  /** At most this many people per import (bigger directories: the rest on the next run). */
  LDAP_CRAWL_LIMIT: z.coerce.number().int().positive().max(200_000).default(50_000),

  /** ADFS (or any OpenID Connect provider). ADFS: https://adfs.example.com/adfs */
  OIDC_ENABLED: envBool(false),
  OIDC_LABEL: z.string().default('Sign in with ADFS'),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  /** `allatclaims` makes ADFS put issued claims (e.g. groups) into the ID token. */
  OIDC_SCOPES: z.string().default('openid profile email allatclaims'),
  OIDC_USERNAME_CLAIM: z.string().default('upn'),
  OIDC_DISPLAY_NAME_CLAIM: z.string().default('unique_name'),
  /** Further name claims people can be searched by (comma-separated). */
  OIDC_NAME_CLAIMS: envList.transform((v) => (v.length ? v : ['given_name', 'family_name', 'name', 'upn'])),
  OIDC_EMAIL_CLAIM: z.string().default('email'),
  OIDC_GROUPS_CLAIM: z.string().default('group'),
  OIDC_ADMIN_GROUPS: envList,
  /** ID-token claims that place people in units, matched as `claim=value`, e.g. department. */
  OIDC_UNIT_CLAIMS: envList,
};

/** The sign-in methods that are on: from AUTH_MODE when set, otherwise from the per-method switches. */
export function signInMethods(config: { AUTH_MODE?: string; LOCAL_AUTH_ENABLED: boolean; LDAP_ENABLED: boolean; OIDC_ENABLED: boolean }): { manual: boolean; ldap: boolean; adfs: boolean; google: boolean } {
  if (!config.AUTH_MODE) return { manual: config.LOCAL_AUTH_ENABLED, ldap: config.LDAP_ENABLED, adfs: config.OIDC_ENABLED, google: false };
  const parts = new Set(config.AUTH_MODE.toLowerCase().split(/[\s,+]+/).filter(Boolean));
  return { manual: parts.has('manual') || parts.has('local'), ldap: parts.has('ldap'), adfs: parts.has('adfs') || parts.has('oidc'), google: parts.has('google') };
}
