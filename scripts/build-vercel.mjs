#!/usr/bin/env node
// Vercel's build (Build Output API v3, .vercel/output):
//   static/                  the web app
//   functions/api.func/      VITE_RUNTIME=server only: every service as one Node function (Neon + S3)
//   config.json              routes (caching, /api/* → the function, the app for everything else)
//                            and, in server mode, the cron that sends reminders twice a day
// VITE_RUNTIME picks the mode: `browser` (default here: no backend, everything in the
// visitor's browser) or `server` (the serverless function).
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = (process.env.VITE_RUNTIME ?? 'browser').trim();
if (mode !== 'server' && mode !== 'browser') throw new Error(`VITE_RUNTIME must be "server" or "browser", not "${mode}"`);
/** Twice a day by default (06:00 and 18:00 UTC); REMINDER_CRON overrides. Hobby plans allow daily crons only. */
const cron = process.env.REMINDER_CRON ?? '0 6,18 * * *';

const out = `${root}/.vercel/output`;
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/static`, { recursive: true });

execSync('pnpm --filter web build', { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_RUNTIME: mode } });
cpSync(`${root}/apps/web/dist`, `${out}/static`, { recursive: true });

if (mode === 'server') {
  const fn = `${out}/functions/api.func`;
  mkdirSync(fn, { recursive: true });
  await build({
    entryPoints: [`${root}/packages/serverless/src/vercel.ts`],
    outfile: `${fn}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: 'linked',
    logLevel: 'warning',
    // Optional native and unused drivers some dependencies try to load.
    external: ['pg-native', 'pino-pretty', '@opentelemetry/exporter-jaeger'],
    // Some dependencies are CommonJS and use require/__dirname.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);",
    },
  });
  writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60, supportsResponseStreaming: false }, null, 2));
}

const immutable = { 'cache-control': 'public, max-age=31536000, immutable' };
const config = {
  version: 3,
  routes: [
    { src: '^/assets/(.*)$', headers: immutable, continue: true },
    { src: '^/pglite/(.*)$', headers: immutable, continue: true },
    { src: '^/sw\\.js$', headers: { 'cache-control': 'no-cache', 'service-worker-allowed': '/' }, continue: true },
    ...(mode === 'server' ? [{ src: '^/api(?:/.*)?$', dest: '/api' }] : []),
    { handle: 'filesystem' },
    // Everything else is a page of the app.
    { src: '^/(?!api/).*$', dest: '/index.html' },
  ],
  ...(mode === 'server' && { crons: [{ path: '/api/cron', schedule: cron }] }),
};
writeFileSync(`${out}/config.json`, JSON.stringify(config, null, 2));
console.log(`vercel output: ${mode} mode${mode === 'server' ? `, function api, cron "${cron}"` : ''}`);
