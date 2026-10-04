/* global process */
import { runCli, formatError, handleUnhandledError } from './cli.js';
import { logError } from './utils/logger.js';
import { exitWithCode } from './utils/exit.js';

let exiting = false;

async function finishWithCode(code: number, codeOverride?: NodeJS.Signals): Promise<void> {
  process.exitCode = code;
  if (exiting) {
    return;
  }
  exiting = true;
  const reason = codeOverride ? ` (signal: ${codeOverride})` : '';
  if (code !== 0) {
    logError(`Process exiting with code ${code}${reason}.`);
  }
  await exitWithCode(code);
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
    void finishWithCode(130, sig);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', (err) => {
    handleUnhandledError(err, 'uncaughtException');
    void finishWithCode(1);
  });
  process.on('unhandledRejection', (reason) => {
    handleUnhandledError(reason, 'unhandledRejection');
    void finishWithCode(1);
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
    await finishWithCode(code);
  } catch (error) {
    logError(`Fatal CLI error: ${formatError(error)}`);
    await finishWithCode(1);
  }
}

main();
