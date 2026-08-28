import { spawn } from 'node:child_process';

const MAX_STDERR_BYTES = 64 * 1024;

export interface SubprocessResult {
  readonly status: number | null;
  readonly stderr: string;
}

/** Runs a render tool without blocking the Worker event loop. */
export function runSubprocess(command: string, args: readonly string[]): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      const bounded = chunk.subarray(0, remaining);
      stderr.push(bounded);
      stderrBytes += bounded.length;
    });
    child.once('error', reject);
    child.once('close', (status) => {
      resolve({ status, stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}
