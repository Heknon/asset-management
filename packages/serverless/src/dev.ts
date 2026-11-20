import { createServer } from 'node:http';
import { ServerlessRuntime } from './runtime.js';

/**
 * Runs the serverless runtime locally on one port (default 3000), the way the
 * Vercel Function does: `pnpm --filter @am/serverless dev`, then point the web
 * app at it with VITE_API_URL=http://localhost:3000.
 */
const runtime = await ServerlessRuntime.start({ COOKIE_SECURE: 'false', ...process.env });
const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => {
  runtime
    .handle(req, res)
    .then(async ({ changed }) => {
      if (changed) await runtime.settle();
    })
    .catch((err: unknown) => {
      runtime.logger.error({ err }, 'request failed');
      if (!res.headersSent) res.writeHead(500).end();
    });
}).listen(port, () => runtime.logger.info(`serverless runtime on http://localhost:${port}`));
