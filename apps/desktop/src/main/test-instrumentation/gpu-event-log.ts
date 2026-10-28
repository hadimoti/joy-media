/**
 * GPU event log for the instrumented build (plan section 10d, G0 item 2a; OA3). It writes one JSON line for each
 * `child-process-gone` event of type GPU to `gpu-events.jsonl` in the user-data folder. A line holds the time, the event
 * type, the reason, the exit code and its normalised form, and nothing else: no paths, no network, no crash reporter.
 *
 * The file is capped at 256 KiB. When the next line would pass the cap, the file moves to `gpu-events.1.jsonl`, which
 * replaces the previous rotation, and a new file starts. A write failure never reaches the app.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const GPU_EVENT_LOG_FILE = 'gpu-events.jsonl';
export const GPU_EVENT_LOG_ROTATED_FILE = 'gpu-events.1.jsonl';
export const GPU_EVENT_LOG_CAP_BYTES = 256 * 1024;

/** The exit code as an unsigned 32-bit hex value. -1073740791 and 3221226505 both give 0xC0000409 (plan section 10e). */
export function normaliseExitCodeHex(code: number): string {
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** The log line for a GPU child-process event, or undefined for every other event. */
export function gpuEventLine(details: unknown, time: Date): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const record = details as Record<string, unknown>;
  if (record['type'] !== 'GPU') return undefined;
  const exitCode = typeof record['exitCode'] === 'number' ? record['exitCode'] : null;
  return JSON.stringify({
    time: time.toISOString(),
    type: 'GPU',
    reason: typeof record['reason'] === 'string' ? record['reason'] : null,
    exitCode,
    exitCodeHex: exitCode === null ? null : normaliseExitCodeHex(exitCode),
  });
}

/** The three file operations the log needs. The app uses node:fs; the tests use memory. */
export interface GpuEventFileSystem {
  /** The size in bytes, or undefined when the file does not exist. */
  size(file: string): number | undefined;
  append(file: string, text: string): void;
  /** Moves `from` to `to`, replacing `to` when it exists. */
  replace(from: string, to: string): void;
}

export const nodeGpuEventFileSystem: GpuEventFileSystem = {
  size(file) {
    try {
      return statSync(file).size;
    } catch {
      return undefined;
    }
  },
  append(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, text, 'utf8');
  },
  replace(from, to) {
    renameSync(from, to);
  },
};

export class GpuEventLog {
  private readonly userDataFolder: () => string;
  private readonly files: GpuEventFileSystem;
  private readonly capBytes: number;

  constructor(
    userDataFolder: () => string,
    files: GpuEventFileSystem,
    capBytes: number = GPU_EVENT_LOG_CAP_BYTES,
  ) {
    this.userDataFolder = userDataFolder;
    this.files = files;
    this.capBytes = capBytes;
  }

  /** Records one child-process event. Returns true when a line was written. Errors are swallowed on purpose. */
  record(details: unknown, time: Date): boolean {
    const line = gpuEventLine(details, time);
    if (line === undefined) return false;
    try {
      const folder = this.userDataFolder();
      const current = join(folder, GPU_EVENT_LOG_FILE);
      const text = `${line}\n`;
      const size = this.files.size(current) ?? 0;
      if (size > 0 && size + Buffer.byteLength(text, 'utf8') > this.capBytes) {
        this.files.replace(current, join(folder, GPU_EVENT_LOG_ROTATED_FILE));
      }
      this.files.append(current, text);
      return true;
    } catch {
      // The log must never stop the app, so a failed write is dropped here.
      return false;
    }
  }
}
