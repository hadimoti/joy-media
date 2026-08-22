import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PrivateObjectIntegrityError,
  RclonePrivateObjectStore,
  type RcloneRunner,
} from './private-object-store.js';

const bytes = new TextEncoder().encode('verified derivative');
const descriptor = {
  ref: 'derivative-1',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.byteLength,
  mimeType: 'image/jpeg',
};

describe('RclonePrivateObjectStore', () => {
  it('keeps the configured remote private and verifies bytes on both write and read', async () => {
    const calls: Array<{ args: readonly string[]; input?: Uint8Array }> = [];
    const runner: RcloneRunner = {
      async run(args, input) {
        calls.push({ args, ...(input === undefined ? {} : { input }) });
        return input ?? bytes;
      },
    };
    const store = new RclonePrivateObjectStore({
      remotePrefix: 'parspack:c212734/sweden-backups/joy-media',
      run: runner,
    });

    await store.put(descriptor, bytes);
    await expect(store.get(descriptor)).resolves.toEqual(bytes);
    await store.remove(descriptor.ref);

    expect(calls.map((call) => call.args)).toEqual([
      ['rcat', 'parspack:c212734/sweden-backups/joy-media/derivative-1', '--log-level', 'ERROR'],
      [
        'link',
        'parspack:c212734/sweden-backups/joy-media/derivative-1',
        '--expire',
        '5m',
        '--log-level',
        'ERROR',
      ],
      [
        'deletefile',
        'parspack:c212734/sweden-backups/joy-media/derivative-1',
        '--log-level',
        'ERROR',
      ],
    ]);
  });

  it('rejects tampered reads instead of returning media bytes', async () => {
    const store = new RclonePrivateObjectStore({
      remotePrefix: 'parspack:c212734/sweden-backups/joy-media',
      run: { run: async () => new TextEncoder().encode('tampered') },
    });
    await expect(store.get(descriptor)).rejects.toBeInstanceOf(PrivateObjectIntegrityError);
  });
});
