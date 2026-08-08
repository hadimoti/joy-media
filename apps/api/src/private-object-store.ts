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

export interface PrivateObjectStore {
  put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void>;
  get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array>;
  remove(ref: string): Promise<void>;
}

export interface RclonePrivateObjectStoreOptions {
  /** Existing root-owned rclone remote, e.g. parspack:c212734/sweden-backups/joy-media. */
  readonly remotePrefix: string;
  readonly command?: string;
  readonly run?: RcloneRunner;
  readonly s3?: S3ObjectClient;
  readonly rcloneConfigPath?: string;
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
  private readonly runner: RcloneRunner | undefined;
  private readonly s3: S3ObjectClient | undefined;

  constructor(private readonly options: RclonePrivateObjectStoreOptions) {
    if (!isRemotePrefix(options.remotePrefix))
      throw new TypeError('object-store remote prefix is invalid');
    this.command = options.command ?? 'rclone';
    this.s3 = options.s3 ?? (options.run ? undefined : createParsPackClient(options));
    this.runner = options.run ?? (this.s3 ? undefined : new SpawnRcloneRunner(this.command));
  }

  async put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void> {
    validateDescriptor(descriptor);
    verify(descriptor, bytes);
    if (this.s3) {
      await this.s3.put(descriptor.ref, bytes);
      return;
    }
    await this.rclone().run(['rcat', this.pathFor(descriptor.ref), '--log-level', 'ERROR'], bytes);
  }

  async get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array> {
    validateDescriptor(descriptor);
    const bytes = this.s3
      ? await this.s3.get(descriptor.ref)
      : await this.rclone().run(['cat', this.pathFor(descriptor.ref), '--log-level', 'ERROR']);
    verify(descriptor, bytes);
    return bytes;
  }

  async remove(ref: string): Promise<void> {
    if (!isOpaqueRef(ref)) throw new TypeError('object-store ref is invalid');
    if (this.s3) {
      await this.s3.remove(ref);
      return;
    }
    await this.rclone().run(['deletefile', this.pathFor(ref), '--log-level', 'ERROR']);
  }

  private pathFor(ref: string): string {
    return `${this.options.remotePrefix.replace(/\/$/, '')}/${ref}`;
  }

  private rclone(): RcloneRunner {
    if (!this.runner) throw new Error('private object store rclone runner is unavailable');
    return this.runner;
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

  run(args: readonly string[], input?: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...args], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (status) => {
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

export interface S3ObjectClient {
  put(ref: string, bytes: Uint8Array): Promise<void>;
  get(ref: string): Promise<Uint8Array>;
  remove(ref: string): Promise<void>;
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
  return new SigV4S3ObjectClient(target, credentials);
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

  private request(
    method: 'PUT' | 'GET' | 'DELETE',
    ref: string,
    bytes?: Uint8Array,
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
          res.once('error', reject);
          res.once('end', () => {
            const statusCode = res.statusCode ?? 0;
            const response = Buffer.concat(chunks);
            if (statusCode >= 200 && statusCode < 300) resolve(new Uint8Array(response));
            else
              reject(
                new Error(
                  `s3 object request failed (${statusCode}) for ${this.target.bucket}/${this.objectKey(ref)}`,
                ),
              );
          });
        },
      );
      req.once('error', reject);
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

function isRemotePrefix(value: string): boolean {
  return /^[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..');
}

function isOpaqueRef(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
