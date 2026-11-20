import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { buildBrowserRuntime } from '../../packages/browser-runtime/build.mjs';

/**
 * VITE_RUNTIME selects where the services run (read from the environment or
 * a .env file; the app reads the same value through import.meta.env):
 *   server   (default) the services run on a server; /api goes to them
 *   browser  the services run inside the browser, in a service worker
 */
const RUN_MODES = ['server', 'browser'] as const;

/** In development each API prefix is proxied to its service; in the cluster nginx does the same. */
const services = { identity: 4001, registry: 4002, files: 4003, scheduler: 4004 };

/** Browser mode: builds the service worker and PGlite next to the app (public/ while developing, the build output otherwise). */
function browserRuntime(): Plugin {
  let outDir = 'dist';
  return {
    name: 'browser-runtime',
    // Before the dev server indexes public/, so the worker is served from the first start.
    async config(_, { command }) {
      if (command === 'serve') await buildBrowserRuntime(fileURLToPath(new URL('./public', import.meta.url)));
    },
    configResolved: (config) => void (outDir = config.build.outDir),
    async closeBundle() {
      await buildBrowserRuntime(outDir);
    },
  };
}

// One .env for the whole repository (the services read it too).
const envDir = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, 'VITE_');
  const runMode = env.VITE_RUNTIME || 'server';
  if (!RUN_MODES.includes(runMode as (typeof RUN_MODES)[number])) throw new Error(`VITE_RUNTIME must be one of ${RUN_MODES.join(', ')} (got "${runMode}")`);
  const inBrowser = runMode === 'browser';
  return {
    plugins: [react(), tailwindcss(), ...(inBrowser ? [browserRuntime()] : [])],
    envDir,
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    // Exposed to the app as import.meta.env.VITE_RUNTIME, defaulted like here.
    define: { 'import.meta.env.VITE_RUNTIME': JSON.stringify(runMode) },
    server: {
      port: 5173,
      // In browser mode the service worker answers /api itself.
      // VITE_API_URL sends all of /api to one place (the serverless runtime: `pnpm --filter @am/serverless dev`).
      proxy: inBrowser
        ? undefined
        : env.VITE_API_URL
          ? { '/api': { target: env.VITE_API_URL, changeOrigin: false } }
          : Object.fromEntries(Object.entries(services).map(([name, port]) => [`/api/${name}`, { target: `http://localhost:${port}`, changeOrigin: false }])),
    },
    build: { sourcemap: true, chunkSizeWarningLimit: 900 },
  };
});
