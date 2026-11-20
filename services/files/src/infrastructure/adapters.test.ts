import { describe, expect, it } from 'bun:test';
import { S3ObjectStorage } from './adapters.js';

const storage = (prefix?: string) =>
  new S3ObjectStorage({ bucket: 'bucket', prefix, region: 'us-east-1', endpoint: 'http://s3.test', forcePathStyle: true, accessKeyId: 'k', secretAccessKey: 's', sse: 'none', ttlSeconds: 60 });

describe('S3ObjectStorage', () => {
  it('puts every key under the prefix', async () => {
    const upload = await storage('preview/pr-7/').presignUpload('asset/file', 'text/plain', 10);
    expect(upload.fields.key).toBe('preview/pr-7/asset/file');
    const { url } = await storage('preview/pr-7/').presignDownload('asset/file', { contentType: 'text/plain', disposition: 'inline' });
    expect(new URL(url).pathname).toBe('/bucket/preview/pr-7/asset/file');
  });

  it('uses the key as it is without a prefix', async () => {
    const upload = await storage().presignUpload('asset/file', 'text/plain', 10);
    expect(upload.fields.key).toBe('asset/file');
  });
});
