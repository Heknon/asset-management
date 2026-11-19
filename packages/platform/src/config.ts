import { z } from 'zod';

/** `z.coerce.boolean()` treats "false" as true; environment flags need this instead. */
export const envBool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? fallback : ['true', '1', 'yes'].includes(v)));

export const envList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));

/** Settings every service needs. Services extend this with their own keys. */
export const baseConfigShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** `json` (default) or `ecs` (Elastic Common Schema, correlates with Elastic APM). */
  LOG_FORMAT: z.enum(['json', 'ecs']).default('json'),
  /** Serve Prometheus metrics on GET /metrics (not exposed through the web proxy). */
  METRICS_ENABLED: envBool(false),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: envBool(false),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Run migrations at startup. Disabled in clusters, where a Helm hook Job runs them. */
  MIGRATE_ON_START: envBool(false),
  /** Externally visible base URL of the web app, used in links and redirects. */
  PUBLIC_URL: z.string().url(),
  AUTH_ISSUER: z.string().default('asset-management'),
  AUTH_AUDIENCE: z.string().default('asset-management'),
  /** JWKS of the identity service; every other service verifies tokens against it. */
  AUTH_JWKS_URL: z.string().url().optional(),
};

const baseSchema = z.object(baseConfigShape);
export type BaseConfig = z.infer<typeof baseSchema>;

export function loadConfig<S extends z.ZodRawShape>(shape: S, env: NodeJS.ProcessEnv = process.env): BaseConfig & z.infer<z.ZodObject<S>> {
  const result = baseSchema.extend(shape).safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  return result.data as BaseConfig & z.infer<z.ZodObject<S>>;
}
