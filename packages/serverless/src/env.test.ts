import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { missingDeploymentSettings, serverlessEnvironment } from './env.js';
import { sharedSecrets, signingKeyPem } from './secrets.js';

const deployed = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://pooled',
  DATABASE_URL_UNPOOLED: 'postgres://direct',
  S3_BUCKET: 'bucket',
  S3_REGION: 'eu-west-1',
  S3_ROLE_ARN: 'role',
  AUTH_SIGNING_KEY: 'generated-signing-secret',
  COOKIE_SECRET: 'a-generated-cookie-secret-of-32-characters',
  CRON_SECRET: 'cron',
};

describe('serverlessEnvironment', () => {
  it('uses the direct connection and the production domain', () => {
    const env = serverlessEnvironment({ ...deployed, VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'assets.example.com' });
    expect(env.DATABASE_URL).toBe('postgres://direct');
    expect(env.PUBLIC_URL).toBe('https://assets.example.com');
    expect(env.MAIL_FROM).toBe('Assets <assets@assets.example.com>');
    expect(env.MIGRATE_ON_START).toBe('false');
  });

  it('never falls back to the pooled connection when deployed', () => {
    expect(serverlessEnvironment({ ...deployed, DATABASE_URL_UNPOOLED: undefined }).DATABASE_URL).toBeUndefined();
  });

  it('uses DATABASE_URL and migrates on start locally', () => {
    const env = serverlessEnvironment({ DATABASE_URL: 'postgres://local' });
    expect(env.DATABASE_URL).toBe('postgres://local');
    expect(env.MIGRATE_ON_START).toBe('true');
    expect(env.PUBLIC_URL).toBe('http://localhost:3000');
  });

  it('prefers what is set explicitly', () => {
    expect(serverlessEnvironment({ ...deployed, PUBLIC_URL: 'https://assets.corp', VERCEL_URL: 'x.vercel.app' }).PUBLIC_URL).toBe('https://assets.corp');
  });

  it("uses a preview's branch URL and names the first admin when only a password is given", () => {
    const env = serverlessEnvironment({ VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'app-git-x.vercel.app', VERCEL_URL: 'app-abc.vercel.app', LOCAL_ADMIN_PASSWORD: 'a-long-password' });
    expect(env.PUBLIC_URL).toBe('https://app-git-x.vercel.app');
    expect(env.LOCAL_ADMIN_USERNAME).toBe('admin');
  });
});

describe('missingDeploymentSettings', () => {
  it('requires nothing locally', () => {
    expect(missingDeploymentSettings({})).toEqual([]);
  });

  it('requires the cron secret in production only', () => {
    expect(missingDeploymentSettings(deployed)).toEqual([]);
    expect(missingDeploymentSettings({ ...deployed, CRON_SECRET: undefined })).toEqual(['CRON_SECRET']);
    expect(missingDeploymentSettings({ ...deployed, APP_ENV: 'preview', CRON_SECRET: undefined })).toEqual([]);
  });

  it('lists missing database, bucket and secrets', () => {
    expect(missingDeploymentSettings({ APP_ENV: 'dev' })).toEqual(['DATABASE_URL_UNPOOLED', 'S3_BUCKET', 'S3_REGION', 'S3_ROLE_ARN', 'AUTH_SIGNING_KEY', 'COOKIE_SECRET']);
  });
});

describe('secrets', () => {
  it('derives the same P-256 key from a random secret every time', () => {
    const a = signingKeyPem('generated-signing-secret');
    expect(a).toBe(signingKeyPem('generated-signing-secret'));
    expect(a).not.toBe(signingKeyPem('another-secret'));
    const key = createPrivateKey(a);
    expect(key.asymmetricKeyType).toBe('ec');
    expect(key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  });

  it('keeps a PEM as it is', () => {
    const pem = signingKeyPem('x');
    expect(signingKeyPem(pem)).toBe(pem);
  });

  it('refuses to generate secrets when deployed', async () => {
    await expect(sharedSecrets(null, { APP_ENV: 'dev' })).rejects.toThrow('AUTH_SIGNING_KEY and COOKIE_SECRET are required');
  });
});
