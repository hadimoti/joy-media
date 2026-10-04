import type { Writable } from 'node:stream';

export interface ExitWithCodeOptions {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly exit?: (code: number) => never;
}

/** Set the exit status immediately, flush pending output, then terminate. */
export async function exitWithCode(
  code: number,
  options: ExitWithCodeOptions & { readonly exit: (code: number) => never },
): Promise<void>;
export async function exitWithCode(code: number): Promise<void>;
export async function exitWithCode(
  code: number,
  options: ExitWithCodeOptions = {
    stdout: process.stdout,
    stderr: process.stderr,
    exit: process.exit,
  },
): Promise<void> {
  process.exitCode = code;
  await Promise.all([flush(options.stdout), flush(options.stderr)]);
  (options.exit ?? process.exit)(code);
}

function flush(stream: Writable): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}
