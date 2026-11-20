import { OidcGoogleClient } from './infrastructure/google.js';
import { nodeDirectories } from './infrastructure/node-directories.js';
import { nodeScrypt } from './infrastructure/node-scrypt.js';
import type { IdentityAdapters } from './service.js';

/** Identity's Node adapters (server and serverless): scrypt from node:crypto, LDAP, ADFS and Google sign-in. */
export const nodeIdentityAdapters: IdentityAdapters = { scrypt: nodeScrypt, directories: nodeDirectories, google: (id, secret) => new OidcGoogleClient(id, secret) };
