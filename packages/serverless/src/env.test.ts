import { describe, expect, it } from 'vitest';
import { browserOrigins, serverlessEnvironment } from './env.js';

describe('serverlessEnvironment', () => {
  it("uses the Neon integration's direct connection and the S3 integration's bucket", () => {
    const env = serverlessEnvironment({
      DATABASE_URL: 'postgres://pooled',
      DATABASE_URL_UNPOOLED: 'postgres://direct',
      STORAGE_S3_BUCKET_NAME: 'assets-bucket',
      STORAGE_AWS_REGION: 'eu-west-1',
      VERCEL_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'assets.example.com',
    });
    expect(env.DATABASE_URL).toBe('postgres://direct');
    expect(env.S3_BUCKET).toBe('assets-bucket');
    expect(env.S3_REGION).toBe('eu-west-1');
    expect(env.PUBLIC_URL).toBe('https://assets.example.com');
    expect(env.MAIL_FROM).toBe('Assets <assets@assets.example.com>');
  });

  it('prefers what the project sets explicitly', () => {
    const env = serverlessEnvironment({ DATABASE_URL_UNPOOLED: 'postgres://direct', S3_BUCKET: 'mine', STORAGE_S3_BUCKET_NAME: 'integration', PUBLIC_URL: 'https://assets.corp', VERCEL_URL: 'x.vercel.app' });
    expect(env.S3_BUCKET).toBe('mine');
    expect(env.PUBLIC_URL).toBe('https://assets.corp');
  });

  it("uses a preview's branch URL and names the first admin when only a password is given", () => {
    const env = serverlessEnvironment({ VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'app-git-x.vercel.app', VERCEL_URL: 'app-abc.vercel.app', LOCAL_ADMIN_PASSWORD: 'a-long-password' });
    expect(env.PUBLIC_URL).toBe('https://app-git-x.vercel.app');
    expect(env.LOCAL_ADMIN_USERNAME).toBe('admin');
  });

  it('lists every origin a browser may use, for the bucket CORS', () => {
    expect(browserOrigins({ PUBLIC_URL: 'https://assets.corp/', VERCEL_URL: 'a.vercel.app', VERCEL_BRANCH_URL: 'b.vercel.app' }).sort()).toEqual(['https://a.vercel.app', 'https://assets.corp', 'https://b.vercel.app']);
  });
});
