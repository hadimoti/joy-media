import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WorkerCapability, WorkerHello } from '@joy-media/job-protocol';
import { WORKER_PROTOCOL_VERSION } from '@joy-media/job-protocol';

export interface DeviceIdentity {
  readonly workerId: string;
  readonly createdAt: string;
}
export interface IdentityStore {
  load(): DeviceIdentity | undefined;
  save(identity: DeviceIdentity): void;
}
export interface PersistentWorkerStore extends IdentityStore {
  loadWorkerSession(): string | undefined;
  saveWorkerSession(sessionToken: string): void;
  clearWorkerSession(): void;
}

export class JsonFileWorkerStore implements PersistentWorkerStore {
  constructor(private readonly path = join(homedir(), '.joy-media', 'worker-state.json')) {}

  load(): DeviceIdentity | undefined {
    return this.read().identity;
  }
  save(identity: DeviceIdentity): void {
    this.write({ ...this.read(), identity });
  }
  loadWorkerSession(): string | undefined {
    return this.read().sessionToken;
  }
  saveWorkerSession(sessionToken: string): void {
    this.write({ ...this.read(), sessionToken });
  }
  clearWorkerSession(): void {
    const { identity } = this.read();
    this.write(identity === undefined ? {} : { identity });
  }

  private read(): { readonly identity?: DeviceIdentity; readonly sessionToken?: string } {
    if (!existsSync(this.path)) return {};
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
      const raw = value as Record<string, unknown>;
      const identity = raw.identity;
      return {
        ...(isDeviceIdentity(identity) ? { identity } : {}),
        ...(typeof raw.sessionToken === 'string' ? { sessionToken: raw.sessionToken } : {}),
      };
    } catch {
      return {};
    }
  }

  private write(state: {
    readonly identity?: DeviceIdentity;
    readonly sessionToken?: string;
  }): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${randomUUID()}`;
    writeFileSync(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}
export function getDeviceIdentity(store: IdentityStore, now = new Date()): DeviceIdentity {
  const existing = store.load();
  if (existing !== undefined) return existing;
  const identity = { workerId: `worker-${randomUUID()}`, createdAt: now.toISOString() };
  store.save(identity);
  return identity;
}
export class BoundedLog {
  readonly #lines: string[] = [];
  constructor(private readonly limit = 200) {}
  write(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > this.limit) this.#lines.splice(0, this.#lines.length - this.limit);
  }
  lines(): readonly string[] {
    return [...this.#lines];
  }
}
export interface ToolAvailability {
  readonly ffmpeg: boolean;
  readonly ffprobe: boolean;
}
export function detectMediaTools(run: (tool: string) => boolean = canRun): ToolAvailability {
  return { ffmpeg: run('ffmpeg'), ffprobe: run('ffprobe') };
}
function canRun(tool: string): boolean {
  const result = spawnSync(tool, ['-version'], { shell: false, stdio: 'ignore' });
  return result.status === 0;
}

function isDeviceIdentity(value: unknown): value is DeviceIdentity {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).workerId === 'string' &&
    typeof (value as Record<string, unknown>).createdAt === 'string'
  );
}
export class WorkerRuntime {
  readonly log = new BoundedLog();
  constructor(
    readonly identity: DeviceIdentity,
    readonly tools: ToolAvailability,
  ) {}
  hello(platform: string, architecture: string): WorkerHello {
    const capabilities: WorkerCapability[] =
      this.tools.ffmpeg && this.tools.ffprobe ? ['asset.thumbnail'] : [];
    return {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerId: this.identity.workerId,
      workerVersion: '0.1.0',
      platform,
      architecture,
      capabilities,
      localAssetIds: [],
      maxConcurrentJobs: 1,
    };
  }
  run(
    jobId: string,
    cancelled: () => boolean,
  ): { readonly tempDir: string; readonly state: 'completed' | 'canceled' } {
    const tempDir = mkdtempSync(join(tmpdir(), `joy-media-${jobId}-`));
    this.log.write(`job ${jobId} temp ${tempDir}`);
    if (cancelled()) {
      this.log.write(`job ${jobId} canceled`);
      return { tempDir, state: 'canceled' };
    }
    this.log.write(`job ${jobId} completed`);
    return { tempDir, state: 'completed' };
  }
}
