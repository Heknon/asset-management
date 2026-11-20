import { nodeDirectories } from './infrastructure/node-directories.js';
import { nodeScrypt } from './infrastructure/node-scrypt.js';
import type { IdentityAdapters } from './service.js';

/** Identity's Node adapters (server and serverless): scrypt from node:crypto, LDAP and ADFS sign-in. */
export const nodeIdentityAdapters: IdentityAdapters = { scrypt: nodeScrypt, directories: nodeDirectories };
