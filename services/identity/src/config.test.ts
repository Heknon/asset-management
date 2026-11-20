import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { identityConfig, signInMethods } from './config.js';

const flags = { LOCAL_AUTH_ENABLED: true, LDAP_ENABLED: false, OIDC_ENABLED: false };

describe('signInMethods', () => {
  it('follows the per-method switches when AUTH_MODE is unset', () => {
    expect(signInMethods({ ...flags, LDAP_ENABLED: true })).toEqual({ manual: true, ldap: true, adfs: false });
  });
  it('takes AUTH_MODE over the switches', () => {
    expect(signInMethods({ ...flags, AUTH_MODE: 'manual' })).toEqual({ manual: true, ldap: false, adfs: false });
    expect(signInMethods({ ...flags, AUTH_MODE: 'ldap, adfs' })).toEqual({ manual: false, ldap: true, adfs: true });
    expect(signInMethods({ ...flags, AUTH_MODE: 'Manual+LDAP' })).toEqual({ manual: true, ldap: true, adfs: false });
  });
  it('rejects unknown methods', () => {
    expect(z.object({ AUTH_MODE: identityConfig.AUTH_MODE }).safeParse({ AUTH_MODE: 'saml' }).success).toBe(false);
    expect(z.object({ AUTH_MODE: identityConfig.AUTH_MODE }).safeParse({ AUTH_MODE: 'manual,ldap' }).success).toBe(true);
  });
});
