/**
 * The settings the services read, from what a Vercel project provides: the
 * Neon and S3 integrations' variables, Vercel's own URLs, and anything the
 * project sets explicitly (which always wins).
 */
export function serverlessEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  const https = (host?: string) => (host ? `https://${host}` : undefined);

  // Neon's direct connection: each service pins its own schema per connection, which the pooled endpoint does not allow.
  out.DATABASE_URL = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_POSTGRES_URL_NON_POOLING ?? env.POSTGRES_URL_NON_POOLING ?? env.DATABASE_URL ?? env.POSTGRES_URL;

  // Links in emails, sign-in redirects and the bucket's CORS: the production domain, or this preview's branch URL.
  out.PUBLIC_URL =
    env.PUBLIC_URL ??
    (env.VERCEL_ENV === 'production' ? https(env.VERCEL_PROJECT_PRODUCTION_URL) : undefined) ??
    https(env.VERCEL_BRANCH_URL) ??
    https(env.VERCEL_URL) ??
    'http://localhost:3000';

  // Vercel's AWS S3 integration (STORAGE_*), or plain AWS variables.
  out.S3_BUCKET ??= env.STORAGE_S3_BUCKET_NAME ?? env.AWS_S3_BUCKET ?? env.S3_BUCKET_NAME;
  out.S3_REGION ??= env.STORAGE_AWS_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  out.S3_ACCESS_KEY_ID ??= env.AWS_ACCESS_KEY_ID;
  out.S3_SECRET_ACCESS_KEY ??= env.AWS_SECRET_ACCESS_KEY;

  out.NODE_ENV ??= 'production';
  out.LOG_LEVEL ??= 'info';
  out.MIGRATE_ON_START ??= 'true';
  // Several services share one small instance; Neon's direct endpoint has a connection limit.
  out.DATABASE_POOL_MAX ??= '2';
  // In-process here, but the files and MCP services' configs ask for them.
  out.REGISTRY_URL ??= out.PUBLIC_URL;
  out.IDENTITY_URL ??= out.PUBLIC_URL;
  out.SCHEDULER_URL ??= out.PUBLIC_URL;
  // Without SMTP_URL mail is logged instead of sent (see the runtime's mailer).
  out.SMTP_URL ??= 'smtp://mail.invalid';
  out.MAIL_FROM ??= `Assets <assets@${new URL(out.PUBLIC_URL).hostname}>`;
  // The first administrator, when only a password is given.
  if (out.LOCAL_ADMIN_PASSWORD) out.LOCAL_ADMIN_USERNAME ??= 'admin';
  return out;
}

/** Every origin a browser may use for this deployment (production, branch and deployment URLs), for the bucket's CORS. */
export function browserOrigins(env: Record<string, string | undefined>): string[] {
  const hosts = [env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_BRANCH_URL, env.VERCEL_URL].filter((h): h is string => !!h).map((h) => `https://${h}`);
  return [...new Set([env.PUBLIC_URL, ...hosts].filter((o): o is string => !!o).map((o) => new URL(o).origin))];
}
