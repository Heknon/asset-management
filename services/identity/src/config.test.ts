import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { identityConfig, signInMethods } from './config.js';

const flags = { LOCAL_AUTH_ENABLED: true, LDAP_ENABLED: false, OIDC_ENABLED: false };

describe('signInMethods', () => {
  it('follows the per-method switches when AUTH_MODE is unset', () => {
    expect(signInMethods({ ...flags, LDAP_ENABLED: true })).toEqual({ manual: true, ldap: true, adfs: false, google: false });
  });
  it('takes AUTH_MODE over the switches', () => {
    expect(signInMethods({ ...flags, AUTH_MODE: 'manual' })).toEqual({ manual: true, ldap: false, adfs: false, google: false });
    expect(signInMethods({ ...flags, AUTH_MODE: 'ldap, adfs' })).toEqual({ manual: false, ldap: true, adfs: true, google: false });
    expect(signInMethods({ ...flags, AUTH_MODE: 'Manual+LDAP' })).toEqual({ manual: true, ldap: true, adfs: false, google: false });
  });
  it('turns on Google alone or with other methods', () => {
    expect(signInMethods({ ...flags, AUTH_MODE: 'google' })).toEqual({ manual: false, ldap: false, adfs: false, google: true });
    expect(signInMethods({ ...flags, AUTH_MODE: 'manual,google' })).toEqual({ manual: true, ldap: false, adfs: false, google: true });
  });
  it('rejects unknown methods', () => {
    expect(z.object({ AUTH_MODE: identityConfig.AUTH_MODE }).safeParse({ AUTH_MODE: 'saml' }).success).toBe(false);
    expect(z.object({ AUTH_MODE: identityConfig.AUTH_MODE }).safeParse({ AUTH_MODE: 'manual,ldap' }).success).toBe(true);
    expect(z.object({ AUTH_MODE: identityConfig.AUTH_MODE }).safeParse({ AUTH_MODE: 'manual,google' }).success).toBe(true);
  });
});

describe('directory name settings', () => {
  const names = z.object({ LDAP_NAME_ATTRIBUTES: identityConfig.LDAP_NAME_ATTRIBUTES, OIDC_NAME_CLAIMS: identityConfig.OIDC_NAME_CLAIMS });
  it('search first name, surname, full name and account names by default', () => {
    expect(names.parse({})).toEqual({
      LDAP_NAME_ATTRIBUTES: ['givenName', 'sn', 'cn', 'name', 'userPrincipalName'],
      OIDC_NAME_CLAIMS: ['given_name', 'family_name', 'name', 'upn'],
    });
  });
  it('take a comma-separated list instead', () => {
    expect(names.parse({ LDAP_NAME_ATTRIBUTES: 'givenName, sn,hebrewName', OIDC_NAME_CLAIMS: 'upn' })).toEqual({
      LDAP_NAME_ATTRIBUTES: ['givenName', 'sn', 'hebrewName'],
      OIDC_NAME_CLAIMS: ['upn'],
    });
  });
});
