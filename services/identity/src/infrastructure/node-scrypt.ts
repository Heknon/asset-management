import { scrypt } from 'node:crypto';
import type { ScryptFn } from './crypto.js';

/** Node's native scrypt (libuv thread pool), for the server. */
export const nodeScrypt: ScryptFn = (password, salt, keylen, { N, r, p }) =>
  new Promise((resolve, reject) => scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(new Uint8Array(key)))));
