import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

export interface PrivateObjectDescriptor {
  readonly ref: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
}

export interface PrivateObjectStoreReadinessOptions {
  readonly timeoutMs?: number;
}

export interface PrivateObjectStore {
  put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void>;
  get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array>;
  remove(ref: string): Promise<void>;
  probeReadiness?(options: PrivateObjectStoreReadinessOptions): Promise<void>;
}

export interface RclonePrivateObjectStoreOptions {
  /** Existing root-owned rclone remote, e.g. parspack:c212734/sweden-backups/joy-media. */
  readonly remotePrefix: string;
  readonly command?: string;
  readonly run?: RcloneRunner;
  readonly s3?: S3ObjectClient;
  readonly rcloneConfigPath?: string;
  /** Deadline for put/get/remove operations, including object-store response bodies. */
  readonly operationTimeoutMs?: number;
}

export interface RcloneRunner {
  run(args: readonly string[], input?: Uint8Array, options?: RcloneRunOptions): Promise<Uint8Array>;
}

export interface RcloneRunOptions {
  readonly timeoutMs?: number;
}

/**
 * Private object storage adapter. rclone and its credential are confined to the
 * API host; refs are opaque filenames under the configured prefix.
 */
export class RclonePrivateObjectStore implements PrivateObjectStore {
  private readonly command: string;
  private readonly runner: RcloneRunner;
  private readonly s3: S3ObjectClient | undefined;
  private readonly operationTimeoutMs: number;

  constructor(private readonly options: RclonePrivateObjectStoreOptions) {
    if (!isRemotePrefix(options.remotePrefix))
      throw new TypeError('object-store remote prefix is invalid');
    this.command = options.command ?? 'rclone';
    const operationTimeoutMs = options.operationTimeoutMs ?? 120_000;
    if (
      !Number.isSafeInteger(operationTimeoutMs) ||
      operationTimeoutMs < 1_000 ||
      operationTimeoutMs > 600_000
    )
      throw new RangeError(
        'private object store operation timeout must be between 1000ms and 600000ms',
      );
    this.operationTimeoutMs = operationTimeoutMs;
    this.s3 = options.s3 ?? (options.run ? undefined : createParsPackClient(options));
    this.runner = options.run ?? new SpawnRcloneRunner(this.command);
  }

  async put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void> {
    validateDescriptor(descriptor);
    verify(descriptor, bytes);
    if (this.s3) {
      await this.s3.put(descriptor.ref, bytes);
      return;
    }
    await this.runRclone(['rcat', this.pathFor(descriptor.ref), '--log-level', 'ERROR'], bytes);
  }

  async get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array> {
    validateDescriptor(descriptor);
    const bytes = this.s3
      ? await this.s3.get(descriptor.ref)
      : await this.runRclone(['cat', this.pathFor(descriptor.ref), '--log-level', 'ERROR']);
    verify(descriptor, bytes);
    return bytes;
  }

  async remove(ref: string): Promise<void> {
    if (!isOpaqueRef(ref)) throw new TypeError('object-store ref is invalid');
    if (this.s3) {
      await this.s3.remove(ref);
      return;
    }
    await this.runRclone(['deletefile', this.pathFor(ref), '--log-level', 'ERROR']);
  }

  async probeReadiness(options: PrivateObjectStoreReadinessOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 2_500;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new RangeError('private object store readiness timeout must be positive');
    const target = parseRemotePrefix(this.options.remotePrefix);
    if (this.s3?.probeReadiness !== undefined) {
      await withTimeout(
        this.s3.probeReadiness({ timeoutMs }),
        timeoutMs,
        'private object store readiness probe timed out',
      );
      return;
    }
    const probeTarget = target
      ? `${target.remoteName}:${target.bucket}`
      : this.options.remotePrefix;
    const output = await withTimeout(
      this.rclone().run(
        [
          'lsjson',
          probeTarget,
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
        undefined,
        { timeoutMs },
      ),
      timeoutMs,
      'private object store readiness probe timed out',
    );
    validateProbeListing(output, target?.prefix);
  }

  private pathFor(ref: string): string {
    return `${this.options.remotePrefix.replace(/\/$/, '')}/${ref}`;
  }

  private rclone(): RcloneRunner {
    return this.runner;
  }

  private async runRclone(args: readonly string[], input?: Uint8Array): Promise<Uint8Array> {
    return withTimeout(
      this.rclone().run(args, input, { timeoutMs: this.operationTimeoutMs }),
      this.operationTimeoutMs,
      'private object store operation timed out',
    );
  }
}

export class PrivateObjectIntegrityError extends Error {
  constructor() {
    super('private object failed integrity verification');
    this.name = 'PrivateObjectIntegrityError';
  }
}

class SpawnRcloneRunner implements RcloneRunner {
  constructor(private readonly command: string) {}

  run(
    args: readonly string[],
    input?: Uint8Array,
    options: RcloneRunOptions = {},
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...args], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timeout =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              child.kill();
              reject(new Error(`rclone operation timed out after ${options.timeoutMs}ms`));
            }, options.timeoutMs);
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        callback();
      };
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => finish(() => reject(error)));
      child.once('close', (status) => {
        finish(() => {
          if (status === 0) resolve(new Uint8Array(Buffer.concat(stdout)));
          else
            reject(
              new Error(
                `rclone failed (${status ?? 'signal'}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
              ),
            );
        });
      });
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input);
    });
  }
}

export interface S3ObjectClient {
  put(ref: string, bytes: Uint8Array): Promise<void>;
  get(ref: string): Promise<Uint8Array>;
  remove(ref: string): Promise<void>;
  probeReadiness?(options: PrivateObjectStoreReadinessOptions): Promise<void>;
}

interface S3RemoteTarget {
  readonly remoteName: string;
  readonly bucket: string;
  readonly prefix: string;
}

interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly endpoint: string;
  readonly region: string;
}

function createParsPackClient(
  options: RclonePrivateObjectStoreOptions,
): S3ObjectClient | undefined {
  const target = parseRemotePrefix(options.remotePrefix);
  if (!target || target.remoteName !== 'parspack') return undefined;
  const credentials = readS3Credentials(target.remoteName, options.rcloneConfigPath);
  if (!credentials) return undefined;
  return new SigV4S3ObjectClient(target, credentials, options.operationTimeoutMs ?? 120_000);
}

function parseRemotePrefix(value: string): S3RemoteTarget | undefined {
  const parsed = /^([A-Za-z0-9._-]+):([^/]+)(?:\/(.*))?$/.exec(value);
  if (!parsed || !parsed[1] || !parsed[2]) return undefined;
  return {
    remoteName: parsed[1],
    bucket: parsed[2],
    prefix: parsed[3]?.replace(/^\/+|\/+$/g, '') ?? '',
  };
}

function readS3Credentials(remoteName: string, explicitPath?: string): S3Credentials | undefined {
  for (const configPath of rcloneConfigCandidates(explicitPath)) {
    if (!existsSync(configPath)) continue;
    const section = parseIniSection(readFileSync(configPath, 'utf8'), remoteName);
    if (!section) continue;
    const accessKeyId = section.access_key_id;
    const secretAccessKey = section.secret_access_key;
    const endpoint = section.endpoint;
    if (!accessKeyId || !secretAccessKey || !endpoint) continue;
    return {
      accessKeyId,
      secretAccessKey,
      endpoint,
      region: section.region ?? 'us-east-1',
    };
  }
  return undefined;
}

function rcloneConfigCandidates(explicitPath?: string): string[] {
  return [
    explicitPath,
    process.env.RCLONE_CONFIG,
    process.env.HOME ? `${process.env.HOME}/.config/rclone/rclone.conf` : undefined,
    '/etc/joy-media/rclone.conf',
  ].filter((value): value is string => Boolean(value));
}

function parseIniSection(
  contents: string,
  sectionName: string,
): Record<string, string> | undefined {
  let active = false;
  let result: Record<string, string> | undefined;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[([^\]]+)]$/.exec(line);
    if (section) {
      const nextSectionName = section[1];
      active = nextSectionName === sectionName;
      if (active) result = {};
      continue;
    }
    if (!active || !result) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

class SigV4S3ObjectClient implements S3ObjectClient {
  private readonly endpoint: URL;

  constructor(
    private readonly target: S3RemoteTarget,
    private readonly credentials: S3Credentials,
    private readonly operationTimeoutMs: number,
  ) {
    this.endpoint = new URL(credentials.endpoint);
    if (this.endpoint.protocol !== 'https:')
      throw new TypeError('private object store endpoint must use https');
  }

  async put(ref: string, bytes: Uint8Array): Promise<void> {
    if (!isOpaqueRef(ref)) throw new TypeError('object-store ref is invalid');
    await this.request('PUT', ref, bytes);
  }

  async get(ref: string): Promise<Uint8Array> {
    if (!isOpaqueRef(ref)) throw new TypeError('object-store ref is invalid');
    return this.request('GET', ref);
  }

  async remove(ref: string): Promise<void> {
    if (!isOpaqueRef(ref)) throw new TypeError('object-store ref is invalid');
    await this.request('DELETE', ref);
  }

  async probeReadiness(options: PrivateObjectStoreReadinessOptions = {}): Promise<void> {
    try {
      await this.request('GET', 'joy-media-readiness-probe', undefined, options.timeoutMs);
    } catch (error) {
      // A signed 404 proves the bucket endpoint and credentials are reachable
      // without mutating or disclosing any private object. Other failures are
      // genuine readiness failures and must remain fail-closed.
      if (error instanceof Error && /s3 object request failed \(404\)/u.test(error.message)) return;
      throw error;
    }
  }

  private request(
    method: 'PUT' | 'GET' | 'DELETE',
    ref: string,
    bytes?: Uint8Array,
    timeoutMs = this.operationTimeoutMs,
  ): Promise<Uint8Array> {
    const body = bytes ? Buffer.from(bytes) : undefined;
    const payloadHash = createHash('sha256')
      .update(body ?? '')
      .digest('hex');
    const amzDate = toAmzDate(new Date());
    const credentialDate = amzDate.slice(0, 8);
    const path = this.objectPath(ref);
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const headers = {
      host: this.endpoint.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const canonicalRequest = [
      method,
      path,
      '',
      Object.entries(headers)
        .map(([key, value]) => `${key}:${value}\n`)
        .join(''),
      signedHeaders,
      payloadHash,
    ].join('\n');
    const credentialScope = `${credentialDate}/${this.credentials.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signature = createHmac(
      'sha256',
      signingKey(this.credentials.secretAccessKey, credentialDate, this.credentials.region),
    )
      .update(stringToSign)
      .digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutRef: { value?: ReturnType<typeof setTimeout> } = {};
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeoutRef.value !== undefined) clearTimeout(timeoutRef.value);
        callback();
      };
      const req = httpsRequest(
        {
          protocol: this.endpoint.protocol,
          hostname: this.endpoint.hostname,
          port: this.endpoint.port || undefined,
          method,
          path,
          headers: {
            ...headers,
            authorization,
            ...(body ? { 'content-length': String(body.byteLength) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.once('error', (error) => finish(() => reject(error)));
          res.once('end', () => {
            const statusCode = res.statusCode ?? 0;
            const response = Buffer.concat(chunks);
            if (statusCode >= 200 && statusCode < 300)
              finish(() => resolve(new Uint8Array(response)));
            else
              finish(() =>
                reject(
                  new Error(
                    `s3 object request failed (${statusCode}) for ${this.target.bucket}/${this.objectKey(ref)}`,
                  ),
                ),
              );
          });
        },
      );
      timeoutRef.value = setTimeout(() => {
        req.destroy(new Error(`s3 object request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      req.once('error', (error) => finish(() => reject(error)));
      if (body) req.end(body);
      else req.end();
    });
  }

  private objectPath(ref: string): string {
    return `/${[this.target.bucket, ...this.objectKey(ref).split('/')].map(encodeURIComponent).join('/')}`;
  }

  private objectKey(ref: string): string {
    return [this.target.prefix, ref].filter(Boolean).join('/');
  }
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = createHmac('sha256', `AWS4${secret}`).update(date).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function validateProbeListing(bytes: Uint8Array, prefix = ''): void {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!Array.isArray(value))
    throw new Error('private object store readiness probe returned invalid listing');
  const entries = value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('private object store readiness probe returned invalid entry');
    const record = entry as Record<string, unknown>;
    if (typeof record.Path !== 'string')
      throw new Error('private object store readiness probe returned invalid path');
    if (typeof record.Name !== 'string')
      throw new Error('private object store readiness probe returned invalid name');
    if (record.IsDir !== true)
      throw new Error('private object store readiness probe returned non-directory entry');
    return record;
  });
  const root = prefix.split('/')[0];
  if (root !== undefined && root !== '' && !entries.some((entry) => entry.Name === root))
    throw new Error('private object store readiness probe could not find configured prefix');
}

function isRemotePrefix(value: string): boolean {
  return /^[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..');
}

function isOpaqueRef(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
