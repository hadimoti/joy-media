import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PrivateObjectIntegrityError,
  RclonePrivateObjectStore,
  type RcloneRunner,
  type S3ObjectClient,
} from './private-object-store.js';

const bytes = new TextEncoder().encode('verified derivative');
const descriptor = {
  ref: 'derivative-1',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.byteLength,
  mimeType: 'image/jpeg',
};

afterEach(() => {
  vi.useRealTimers();
});

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
      ['cat', 'parspack:c212734/sweden-backups/joy-media/derivative-1', '--log-level', 'ERROR'],
      [
        'deletefile',
        'parspack:c212734/sweden-backups/joy-media/derivative-1',
        '--log-level',
        'ERROR',
      ],
    ]);
  });

  it('uses an injected private S3 client before falling back to rclone', async () => {
    const calls: string[] = [];
    const s3: S3ObjectClient = {
      async put(ref, input) {
        calls.push(`put:${ref}:${input.byteLength}`);
      },
      async get(ref) {
        calls.push(`get:${ref}`);
        return bytes;
      },
      async remove(ref) {
        calls.push(`remove:${ref}`);
      },
    };
    const store = new RclonePrivateObjectStore({
      remotePrefix: 'parspack:c212734/sweden-backups/joy-media',
      s3,
    });

    await store.put(descriptor, bytes);
    await expect(store.get(descriptor)).resolves.toEqual(bytes);
    await store.remove(descriptor.ref);

    expect(calls).toEqual(['put:derivative-1:19', 'get:derivative-1', 'remove:derivative-1']);
  });

  it('rejects tampered reads instead of returning media bytes', async () => {
    const store = new RclonePrivateObjectStore({
      remotePrefix: 'parspack:c212734/sweden-backups/joy-media',
      run: { run: async () => new TextEncoder().encode('tampered') },
    });
    await expect(store.get(descriptor)).rejects.toBeInstanceOf(PrivateObjectIntegrityError);
  });

  it('probes remote readiness with a bounded non-mutating stat call', async () => {
    const calls: Array<readonly string[]> = [];
    const store = new RclonePrivateObjectStore({
      remotePrefix: 'parspack:c212734/sweden-backups/joy-media',
      run: {
        async run(args) {
          calls.push(args);
          return new TextEncoder().encode(
            JSON.stringify([{ Path: 'sweden-backups', Name: 'sweden-backups', IsDir: true }]),
          );
        },
      },
    });

    await expect(store.probeReadiness?.({ timeoutMs: 250 })).resolves.toBeUndefined();
    expect(calls).toEqual([
      [
        'lsjson',
        'parspack:c212734',
        '--max-depth',
        '1',
        '--dirs-only',
        '--no-modtime',
        '--timeout',
        '2s',
        '--contimeout',
        '2s',
        '--log-level',
        'ERROR',
      ],
    ]);
  });

  it('rejects invalid readiness probe metadata instead of claiming reachability', async () => {
    const store = new RclonePrivateObjectStore({
      remotePrefix: 'parspack:c212734/sweden-backups/joy-media',
      run: {
        run: async () =>
          new TextEncoder().encode(
            JSON.stringify([{ Path: 'not-a-dir', Name: 'x', IsDir: false }]),
          ),
      },
    });

    await expect(store.probeReadiness?.({ timeoutMs: 250 })).rejects.toThrow(
      'private object store readiness probe returned non-directory entry',
    );
  });

  it('times out a stalled readiness probe', async () => {
    vi.useFakeTimers();
    const store = new RclonePrivateObjectStore({
      remotePrefix: 'parspack:c212734/sweden-backups/joy-media',
      run: { run: () => new Promise<Uint8Array>(() => undefined) },
    });

    const pending = expect(store.probeReadiness?.({ timeoutMs: 25 })).rejects.toThrow(
      'private object store readiness probe timed out',
    );
    await vi.advanceTimersByTimeAsync(25);
    await pending;
  });

  it('bounds object operations instead of leaving a stalled rclone call in flight', async () => {
    vi.useFakeTimers();
    const store = new RclonePrivateObjectStore({
      remotePrefix: 'parspack:c212734/sweden-backups/joy-media',
      operationTimeoutMs: 1_000,
      run: { run: () => new Promise<Uint8Array>(() => undefined) },
    });

    const pending = expect(store.get(descriptor)).rejects.toThrow(
      'private object store operation timed out',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
  });

  it('rejects unsafe object operation timeout configuration', () => {
    expect(
      () =>
        new RclonePrivateObjectStore({
          remotePrefix: 'parspack:c212734/sweden-backups/joy-media',
          operationTimeoutMs: 999,
          run: { run: async () => bytes },
        }),
    ).toThrow('private object store operation timeout must be between 1000ms and 600000ms');
  });
});
