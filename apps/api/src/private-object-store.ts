import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface PrivateObjectDescriptor {
  readonly ref: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
}

export interface PrivateObjectStore {
  put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void>;
  get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array>;
  remove(ref: string): Promise<void>;
}

export interface RclonePrivateObjectStoreOptions {
  /** Existing root-owned rclone remote, e.g. parspack:c212734/sweden-backups/joy-media. */
  readonly remotePrefix: string;
  readonly command?: string;
  /** Bound a remote read/write so a stalled object-store connection cannot hang an API request forever. */
  readonly timeoutMs?: number;
  readonly run?: RcloneRunner;
}

export interface RcloneRunner {
  run(args: readonly string[], input?: Uint8Array): Promise<Uint8Array>;
}

/**
 * Private object storage adapter. rclone and its credential are confined to the
 * API host; refs are opaque filenames under the configured prefix.
 */
export class RclonePrivateObjectStore implements PrivateObjectStore {
  private readonly command: string;
  private readonly runner: RcloneRunner;

  constructor(private readonly options: RclonePrivateObjectStoreOptions) {
    if (!isRemotePrefix(options.remotePrefix))
      throw new TypeError('object-store remote prefix is invalid');
    this.command = options.command ?? 'rclone';
    this.runner = options.run ?? new SpawnRcloneRunner(this.command, options.timeoutMs);
  }

  async put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void> {
    validateDescriptor(descriptor);
    verify(descriptor, bytes);
    await this.runner.run(['rcat', this.pathFor(descriptor.ref), '--log-level', 'ERROR'], bytes);
  }

  async get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array> {
    validateDescriptor(descriptor);
    // ParsPack reliably serves a short-lived signed URL, while its direct
    // rclone GET/HEAD path can stall on private objects. Fetch the signed URL
    // from the API host so credentials never leave the server.
    const link = await this.runner.run([
      'link',
      this.pathFor(descriptor.ref),
      '--expire',
      '5m',
      '--log-level',
      'ERROR',
    ]);
    const linkText = Buffer.from(link).toString('utf8').trim();
    const bytes = /^https?:\/\//i.test(linkText) ? await fetchPrivateObject(linkText) : link;
    verify(descriptor, bytes);
    return bytes;
  }

  async remove(ref: string): Promise<void> {
    if (!isOpaqueRef(ref)) throw new TypeError('object-store ref is invalid');
    await this.runner.run(['deletefile', this.pathFor(ref), '--log-level', 'ERROR']);
  }

  private pathFor(ref: string): string {
    return `${this.options.remotePrefix.replace(/\/$/, '')}/${ref}`;
  }
}

async function fetchPrivateObject(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`signed object fetch failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export class PrivateObjectIntegrityError extends Error {
  constructor() {
    super('private object failed integrity verification');
    this.name = 'PrivateObjectIntegrityError';
  }
}

class SpawnRcloneRunner implements RcloneRunner {
  constructor(
    private readonly command: string,
    private readonly timeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('rclone timeout must be a positive integer');
    }
  }

  run(args: readonly string[], input?: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...args], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`rclone timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (status === 0) resolve(new Uint8Array(Buffer.concat(stdout)));
        else
          reject(
            new Error(
              `rclone failed (${status ?? 'signal'}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
            ),
          );
      });
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input);
    });
  }
}

function validateDescriptor(value: PrivateObjectDescriptor): void {
  if (
    !isOpaqueRef(value.ref) ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0
  )
    throw new TypeError('private object descriptor is invalid');
  if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(value.mimeType))
    throw new TypeError('private object mime type is invalid');
}

function verify(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): void {
  if (
    bytes.byteLength !== descriptor.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256
  )
    throw new PrivateObjectIntegrityError();
}

function isRemotePrefix(value: string): boolean {
  return /^[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..');
}

function isOpaqueRef(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
