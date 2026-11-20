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

  // Links in emails and sign-in redirects: APP_URL (production and dev), a preview's own URL, or locally PUBLIC_URL.
  out.PUBLIC_URL = (env.APP_URL ?? https(env.VERCEL_BRANCH_URL ?? env.VERCEL_URL) ?? (deployed ? undefined : env.PUBLIC_URL) ?? 'http://localhost:3000').replace(/\/+$/, '');
  // Previews of this team may finish Google sign-in through the dev deployment.
  out.AUTH_PREVIEW_HOST_SUFFIX ??= vercelTeamSuffix(env.VERCEL_URL, env.VERCEL_PROJECT_NAME);

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

/**
 * `-<team>.vercel.app`, from a deployment URL `<project>-<hash>-<team>.vercel.app`:
 * every preview of the team's projects ends with it.
 */
export function vercelTeamSuffix(deploymentHost?: string, project?: string): string | undefined {
  if (!deploymentHost || !project) return undefined;
  const host = deploymentHost.toLowerCase();
  const prefix = `${project.toLowerCase()}-`;
  if (!host.startsWith(prefix) || !host.endsWith('.vercel.app')) return undefined;
  const team = /^[a-z0-9]+-([a-z0-9-]+)\.vercel\.app$/.exec(host.slice(prefix.length))?.[1];
  return team ? `-${team}.vercel.app` : undefined;
}

const googleOn = (mode?: string) => !!mode && mode.toLowerCase().split(/[\s,+]+/).includes('google');

/** What a deployment (APP_ENV set) must provide; locally nothing is required. */
export function missingDeploymentSettings(env: Record<string, string | undefined>): string[] {
  if (!env.APP_ENV) return [];
  const preview = env.APP_ENV === 'preview';
  const required = [
    'DATABASE_URL_UNPOOLED',
    'S3_BUCKET',
    'S3_REGION',
    'S3_ROLE_ARN',
    'AUTH_SIGNING_KEY',
    'COOKIE_SECRET',
    ...(preview ? [] : ['APP_URL']),
    ...(env.APP_ENV === 'production' ? ['CRON_SECRET'] : []),
    ...(googleOn(env.AUTH_MODE) ? ['AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET', 'AUTH_SECRET', ...(preview ? ['AUTH_REDIRECT_PROXY_URL'] : ['AUTH_URL'])] : []),
  ];
  return required.filter((name) => !env[name]);
}
