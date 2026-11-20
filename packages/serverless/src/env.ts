/**
 * The settings the services read, from what a deployment provides: the kit's
 * variables (APP_ENV, DATABASE_URL_UNPOOLED, S3_*), Vercel's own URLs, and
 * anything set explicitly (which always wins).
 */
export function serverlessEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  const https = (host?: string) => (host ? `https://${host}` : undefined);
  const deployed = !!env.APP_ENV;

  // The direct connection: each service pins its own schema per connection, which a pooled endpoint does not allow.
  out.DATABASE_URL = deployed ? env.DATABASE_URL_UNPOOLED : (env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL);

  // Links in emails and sign-in redirects: the production domain, or this deployment's branch URL.
  out.PUBLIC_URL =
    env.PUBLIC_URL ??
    (env.VERCEL_ENV === 'production' ? https(env.VERCEL_PROJECT_PRODUCTION_URL) : undefined) ??
    https(env.VERCEL_BRANCH_URL) ??
    https(env.VERCEL_URL) ??
    'http://localhost:3000';

  out.NODE_ENV ??= 'production';
  out.LOG_LEVEL ??= 'info';
  // Deployments migrate before they go live (`bun run db:migrate:deploy`); locally the runtime migrates on start.
  out.MIGRATE_ON_START ??= deployed ? 'false' : 'true';
  // Several services share one small instance; Neon's direct endpoint has a connection limit.
  out.DATABASE_POOL_MAX ??= '2';
  // In-process here, but the files and MCP services' configs ask for them.
  out.REGISTRY_URL ??= out.PUBLIC_URL;
  out.IDENTITY_URL ??= out.PUBLIC_URL;
  out.SCHEDULER_URL ??= out.PUBLIC_URL;
  // Without SMTP_URL mail is not sent (see the runtime's mailer).
  out.SMTP_URL ??= 'smtp://mail.invalid';
  out.MAIL_FROM ??= `Assets <assets@${new URL(out.PUBLIC_URL).hostname}>`;
  // The first administrator, when only a password is given.
  if (out.LOCAL_ADMIN_PASSWORD) out.LOCAL_ADMIN_USERNAME ??= 'admin';
  return out;
}

/** What a deployment (APP_ENV set) must provide; locally nothing is required. */
export function missingDeploymentSettings(env: Record<string, string | undefined>): string[] {
  if (!env.APP_ENV) return [];
  const required = ['DATABASE_URL_UNPOOLED', 'S3_BUCKET', 'S3_REGION', 'S3_ROLE_ARN', 'AUTH_SIGNING_KEY', 'COOKIE_SECRET', ...(env.APP_ENV === 'production' ? ['CRON_SECRET'] : [])];
  return required.filter((name) => !env[name]);
}
