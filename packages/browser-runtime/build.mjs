// Builds the browser runtime: dist/sw.js (the service worker) and the PGlite
// binaries it loads, into the given output folder (the web app's dist).
//   node build.mjs <outDir>
import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(here, 'dist');
const require = createRequire(import.meta.url);
const pgliteDist = dirname(require.resolve('@electric-sql/pglite'));
const { version } = JSON.parse(await readFile(join(pgliteDist, '..', 'package.json'), 'utf8'));
// Versioned, so the binaries can be cached forever.
const pgliteDir = `/pglite/${version}/`;

await mkdir(join(outDir, pgliteDir), { recursive: true });
await Promise.all(['pglite.wasm', 'initdb.wasm', 'pglite.data', 'pg_trgm.tar.gz'].map((f) => copyFile(join(pgliteDist, f), join(outDir, pgliteDir, f))));

const result = await build({
  entryPoints: [join(here, 'src/sw.ts')],
  outfile: join(outDir, 'sw.js'),
  bundle: true,
  // A classic (non-module) worker script: supported by every browser with service workers.
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  metafile: true,
  define: { __PGLITE_DIR__: JSON.stringify(pgliteDir), 'import.meta.url': '__PGLITE_BASE__', 'process.env.NODE_ENV': '"production"' },
  banner: { js: `var __PGLITE_BASE__ = self.location.origin + ${JSON.stringify(pgliteDir + 'pglite.js')};` },
  // PGlite's Node-only code paths (never taken in a browser).
  external: ['fs', 'fs/promises', 'node:module', 'stream', 'stream/promises', 'zlib', 'path', 'crypto', 'url', 'module'],
  logLevel: 'warning',
});
const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`browser runtime → ${join(outDir, 'sw.js')} (${(bytes / 1024).toFixed(0)} kB), PGlite ${version} → ${pgliteDir}`);
