import { defineFilesService } from '@am/files/service';
import { nodeFilesAdapters, type NodeFilesOptions } from '@am/files/node';
import { defineIdentityService } from '@am/identity/service';
import { nodeIdentityAdapters } from '@am/identity/node';
import type { OutboxTable, ServiceDefinition } from '@am/platform';
import { defineMcpService } from '@am/mcp/service';
import { registryService } from '@am/registry/service';
import { defineSchedulerService, type SchedulerAdapters } from '@am/scheduler/service';
import type { z } from 'zod';

export interface ServiceOptions {
  s3Credentials?: NodeFilesOptions['credentials'];
  /** How files and MCP reach the other services (in-process in the runtime). */
  fetcher?: typeof fetch;
  mailer: SchedulerAdapters['mailer'];
}

/** The five services, identity first: the others verify tokens against its keys. */
export function serviceDefinitions(opts: ServiceOptions): Array<ServiceDefinition<OutboxTable, z.ZodRawShape>> {
  return [
    defineIdentityService(nodeIdentityAdapters),
    registryService,
    defineFilesService(nodeFilesAdapters({ credentials: opts.s3Credentials, fetcher: opts.fetcher })),
    defineSchedulerService({ mailer: opts.mailer }),
    defineMcpService({ fetcher: opts.fetcher }),
  ] as unknown as Array<ServiceDefinition<OutboxTable, z.ZodRawShape>>;
}
