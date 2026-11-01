/* global process */
// MUST stay the first import: silences node:sqlite's ExperimentalWarning before it is delivered.
import './process-warnings.js';
import { runCli, formatError, handleUnhandledError } from './cli.js';
import { logError } from './utils/logger.js';

let exiting = false;

/** Conventional shell exit status for a process stopped by a signal (128 + signo). */
export const SIGNAL_EXIT_CODES: Readonly<Partial<Record<NodeJS.Signals, number>>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

async function exitWithCode(code: number, codeOverride?: NodeJS.Signals): Promise<void> {
  if (exiting) {
    process.exit(code);
    return;
  }
  exiting = true;
  // Record the code first: if anything below lets the event loop drain, Node
  // still exits with the right status instead of falling back to 0.
  process.exitCode = code;
  if (code !== 0 && process.env.JOY_CLI_DEBUG) {
    const reason = codeOverride ? ` (signal: ${codeOverride})` : '';
    logError(`Process exiting with code ${code}${reason}.`);
  }
  // Give async logs a chance to flush before exiting. The safety timer is
  // intentionally NOT unref'd, otherwise an idle loop exits early and drops
  // the exit code.
  let flushTimeout: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all([flushStream(process.stdout), flushStream(process.stderr)]),
    new Promise<void>((resolve) => {
      flushTimeout = setTimeout(resolve, 250);
    }),
  ]);
  if (flushTimeout) clearTimeout(flushTimeout);
  if (process.platform !== 'win32') process.exit(code);
}

function flushStream(stream: NodeJS.WriteStream | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      if (!stream || stream.destroyed || !stream.writable) {
        resolve();
        return;
      }
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * The reader went away (`joy-media ... | head -1`). That is not a failure of
 * the command: stop writing to that stream and let the command finish with its
 * own exit code instead of dying with an unhandled `write EPIPE`.
 */
function isBrokenPipe(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET';
}

function installStreamErrorHandlers(): void {
  process.stdout.on('error', (err) => {
    if (isBrokenPipe(err)) return;
    logError(`Cannot write to stdout: ${formatError(err)}`);
    void exitWithCode(1);
  });
  process.stderr.on('error', (err) => {
    if (isBrokenPipe(err)) return;
    void exitWithCode(1);
  });
}

function installSignalHandlers(): void {
  const onSignal = (sig: NodeJS.Signals): void => {
    const code = SIGNAL_EXIT_CODES[sig] ?? 130;
    // A second signal while shutting down exits immediately.
    if (exiting) {
      process.exit(code);
      return;
    }
    // For long-running operations (REPL, agent run), let the inner handler decide.
    if (currentLongRunning > 0) {
      logError(`Received ${sig}. Cancelling long-running operation...`);
      currentLongRunning = -1; // mark cancel requested
      return;
    }
    logError(`Received ${sig}. Shutting down.`);
    void exitWithCode(code, sig);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', (err) => {
    handleUnhandledError(err, 'uncaughtException');
    void exitWithCode(1);
  });
  process.on('unhandledRejection', (reason) => {
    handleUnhandledError(reason, 'unhandledRejection');
    void exitWithCode(1);
  });
}

// Tracks whether a long-running operation is in flight so signal handlers
// can decide whether to immediately exit or propagate cancellation.
export let currentLongRunning = 0;

export function trackLongRunning<T>(fn: () => Promise<T>): Promise<T> {
  currentLongRunning++;
  return fn().finally(() => {
    currentLongRunning = Math.max(0, currentLongRunning - 1);
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  installStreamErrorHandlers();
  installSignalHandlers();
  try {
    const code = await runCli(argv);
    await exitWithCode(code);
  } catch (error) {
    logError(`Fatal CLI error: ${formatError(error)}`);
    await exitWithCode(1);
  }
}

main();
