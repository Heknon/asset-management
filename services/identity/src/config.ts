import { envBool, envList } from '@am/platform';
import { z } from 'zod';

export const identityConfig = {
  /** PKCS#8 PEM EC P-256 key used to sign access tokens. Generated per process in development only. */
  AUTH_SIGNING_KEY: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  COOKIE_SECRET: z.string().min(32),
  COOKIE_SECURE: envBool(true),

  /** Break-glass local administrator. Leave unset to disable local login entirely. */
  LOCAL_AUTH_ENABLED: envBool(true),
  LOCAL_ADMIN_USERNAME: z.string().optional(),
  LOCAL_ADMIN_PASSWORD: z.string().min(12).optional(),

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
  LDAP_EMAIL_ATTRIBUTE: z.string().default('mail'),
  LDAP_GROUP_MEMBERSHIP_ATTRIBUTE: z.string().default('memberOf'),
  /** Optional group search for directories without memberOf (e.g. OpenLDAP groupOfNames). `{dn}` is the user DN. */
  LDAP_GROUP_BASE_DN: z.string().optional(),
  LDAP_GROUP_FILTER: z.string().default('(|(member={dn})(uniqueMember={dn}))'),
  LDAP_ADMIN_GROUPS: envList,

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
  OIDC_EMAIL_CLAIM: z.string().default('email'),
  OIDC_GROUPS_CLAIM: z.string().default('group'),
  OIDC_ADMIN_GROUPS: envList,
};
