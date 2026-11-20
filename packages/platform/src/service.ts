import type { FastifyInstance } from 'fastify';
import type { Migration } from 'kysely';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { TokenVerifier } from './auth.js';
import type { BaseConfig } from './config.js';
import type { Database } from './db.js';
import type { EventBus } from './events.js';

/**
 * What a service is given to run: the same in every runtime. On the server
 * (`runService` in `@am/platform/node`): Postgres, pg-boss and Fastify. In
 * the browser (`@am/browser-runtime`): PGlite, an in-memory bus and an
 * in-process router with Fastify's request/reply shape.
 */
export interface ServiceContext<DB, C> {
  name: string;
  config: BaseConfig & C;
  logger: Logger;
  database: Database<DB>;
  bus: EventBus;
  app: FastifyInstance;
  /** Registers cleanup to run on shutdown (reverse order). */
  onClose(fn: () => Promise<void> | void): void;
}

export interface ServiceDefinition<DB, S extends z.ZodRawShape> {
  /** Also the Postgres schema the service owns. */
  name: string;
  config: S;
  migrations: Record<string, Migration>;
  /** Defaults to verifying against the identity service's JWKS. */
  verifier?: (deps: { config: BaseConfig & z.infer<z.ZodObject<S>>; database: Database<DB> }) => Promise<TokenVerifier> | TokenVerifier;
  bodyLimit?: number;
  register(ctx: ServiceContext<DB, z.infer<z.ZodObject<S>>>): Promise<void>;
}

/** Keeps the definition's types without restating them at each call site. */
export const defineService = <DB, S extends z.ZodRawShape>(def: ServiceDefinition<DB, S>): ServiceDefinition<DB, S> => def;
