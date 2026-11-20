import type { IncomingMessage, ServerResponse } from 'node:http';
import { waitUntil } from '@vercel/functions';
import { attachDatabasePool } from '@vercel/functions/db-connections';
import { awsCredentialsProvider } from '@vercel/functions/oidc';
import { ServerlessRuntime } from './runtime.js';

let runtime: Promise<ServerlessRuntime> | null = null;

/** One runtime per function instance, started on its first request (a failed start is retried on the next). */
function getRuntime(): Promise<ServerlessRuntime> {
  runtime ??= ServerlessRuntime.start(process.env, {
    // Vercel's AWS integration: the function assumes the bucket's role with its OIDC token; no access keys.
    s3Credentials: process.env.STORAGE_AWS_ROLE_ARN && !process.env.S3_ACCESS_KEY_ID ? awsCredentialsProvider({ roleArn: process.env.STORAGE_AWS_ROLE_ARN }) : undefined,
    onPool: (pool) => attachDatabasePool(pool),
  }).catch((err: unknown) => {
    runtime = null;
    throw err;
  });
  return runtime;
}

/** The Vercel Function behind /api/*: every service, the health check and the cron endpoint. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let rt: ServerlessRuntime;
  try {
    rt = await getRuntime();
  } catch (err) {
    // Misconfiguration (a missing variable, an unreachable database) shows up here and in the function logs.
    console.error(err);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'unavailable', message: `The server could not start: ${err instanceof Error ? err.message : String(err)}` } }));
    return;
  }
  const { changed } = await rt.handle(req, res);
  // Deliver what the change caused after the response is sent; whatever does not finish stays queued for the next request or cron run.
  if (changed) waitUntil(rt.settle().catch((err: unknown) => rt.logger.error({ err }, 'delivering events failed')));
}
