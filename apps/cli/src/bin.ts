/* global process */
import { runCli, formatError, handleUnhandledError } from './cli.js';
import { logError } from './utils/logger.js';

let exiting = false;

async function exitWithCode(code: number, codeOverride?: NodeJS.Signals): Promise<void> {
  if (exiting) {
    process.exit(code);
    return;
  }
  exiting = true;
  const reason = codeOverride ? ` (signal: ${codeOverride})` : '';
  if (code !== 0) {
    logError(`Process exiting with code ${code}${reason}.`);
  }
  // Give async logs a chance to flush before exiting.
  await new Promise<void>((resolve) => {
    if (typeof process.stdout?.once === 'function') {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        process.stdout.once('drain', done);
        process.stdout.once('close', done);
      } catch {
        done();
      }
      setTimeout(done, 50).unref();
    } else {
      resolve();
    }
  });
  process.exit(code);
}

function installSignalHandlers(): void {
  const onSignal = (sig: NodeJS.Signals): void => {
    if (exiting) return;
    // For long-running operations (REPL, agent run), let the inner handler decide.
    if (currentLongRunning > 0) {
      logError(`Received ${sig}. Cancelling long-running operation...`);
      currentLongRunning = -1; // mark cancel requested
      return;
    }
    logError(`Received ${sig}. Shutting down gracefully.`);
    void exitWithCode(130, sig);
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
