/* global console, process */
import {
  c,
  logError,
  logInfo,
  logStep,
  logSuccess,
  logWarn,
  printBanner,
} from '../utils/logger.js';

/**
 * Output sink for the agent commands.
 *
 * Human mode prints exactly what the CLI always printed. In `--json` mode
 * stdout is reserved for the single JSON result document; progress and
 * human-readable notes go to stderr instead so a caller can `JSON.parse`
 * stdout unconditionally.
 */
export interface AgentOutput {
  readonly json: boolean;
  banner(): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  step(label: string, detail: string): void;
  line(text?: string): void;
  /** Streamed model text (no trailing newline). */
  write(text: string): void;
  error(message: string): void;
  /** The machine-readable result (JSON mode only; ignored in human mode). */
  result(payload: unknown): void;
}

export function createAgentOutput(json: boolean): AgentOutput {
  if (!json) {
    return {
      json: false,
      banner: printBanner,
      info: logInfo,
      success: logSuccess,
      warn: logWarn,
      step: logStep,
      line: (text = '') => console.log(text),
      write: (text) => {
        process.stdout.write(c(text, 'dim'));
      },
      error: logError,
      result: () => {},
    };
  }
  const toStderr = (text: string): void => {
    process.stderr.write(`${text}\n`);
  };
  return {
    json: true,
    banner: () => {},
    info: (message) => toStderr(`i ${message}`),
    success: (message) => toStderr(`ok ${message}`),
    warn: (message) => toStderr(`! ${message}`),
    step: (label, detail) => toStderr(`  - ${label}: ${detail}`),
    line: (text = '') => {
      if (text) toStderr(text);
    },
    write: (text) => {
      process.stderr.write(text);
    },
    error: logError,
    result: (payload) => {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    },
  };
}

/** Mask a secret for display: never reveal more than its last 4 characters. */
export function maskSecret(secret: string | undefined): string | null {
  if (!secret) return null;
  return secret.length >= 16 ? `****${secret.slice(-4)}` : '****';
}
