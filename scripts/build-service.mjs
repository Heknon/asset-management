#!/usr/bin/env node
// Bundles one service (run from its directory) into dist/main.mjs: a single
// self-contained ESM file, so runtime images need no node_modules at all.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'linked',
  minifySyntax: true,
  legalComments: 'linked',
  // Optional native/peer modules that libraries probe for at runtime.
  external: ['pg-native', '@aws-sdk/signature-v4-crt', 'aws-crt', 'pino-pretty'],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
});

console.log(`built ${pkg.name} → dist/main.mjs`);
