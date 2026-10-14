/* global console, process */

export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgCyan: '\x1b[46m',
  bgMagenta: '\x1b[45m',
};

// ---------------------------------------------------------------------------
// Machine output mode
// ---------------------------------------------------------------------------

let machineOutput = false;

/**
 * Machine output mode (set by the dispatcher when `--json` is passed).
 *
 * While enabled, STDOUT IS RESERVED FOR THE COMMAND'S JSON: the banner is
 * suppressed, every human log helper (`logInfo`, `logSuccess`, `logWarn`,
 * `logStep`, `printTable`) writes to stderr instead, and no ANSI colour is
 * emitted on either stream. Commands print their JSON with {@link printJson}
 * (or their own `console.log(JSON.stringify(...))`).
 */
export function setMachineOutput(enabled: boolean): void {
  machineOutput = enabled;
}

export function isMachineOutput(): boolean {
  return machineOutput;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * Whether ANSI colour may be written to `stream`. Decided per stream and per
 * call: `FORCE_COLOR` (anything but `0`/`false`) forces colour on, a non-empty
 * `NO_COLOR` or `TERM=dumb` turns it off, otherwise only TTYs get colour.
 * Machine output mode never gets colour.
 */
export function colorEnabled(stream: { isTTY?: boolean } | undefined): boolean {
  if (machineOutput) return false;
  const env = process.env;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return !(force === '0' || force.toLowerCase() === 'false');
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return stream?.isTTY === true;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Colourise `text` for STDOUT (where most composed text ends up). Text that is
 * routed to stderr is re-checked against stderr's capabilities on write.
 */
export function c(text: string, color: keyof typeof colors): string {
  if (!colorEnabled(process.stdout)) return text;
  return `${colors[color]}${text}${colors.reset}`;
}

function paint(text: string, color: keyof typeof colors, stream: { isTTY?: boolean }): string {
  return colorEnabled(stream) ? `${colors[color]}${text}${colors.reset}` : text;
}

function forStream(text: string, stream: { isTTY?: boolean }): string {
  return colorEnabled(stream) ? text : stripAnsi(text);
}

/** Human-readable output: stdout normally, stderr in machine output mode. */
function human(line: string): void {
  if (machineOutput) {
    console.error(forStream(line, process.stderr));
  } else {
    console.log(forStream(line, process.stdout));
  }
}

function humanStream(): { isTTY?: boolean } {
  return machineOutput ? process.stderr : process.stdout;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function printBanner(): void {
  if (machineOutput) return;
  console.log(
    `${c('  ██████╗  ██████╗ ██╗   ██╗', 'magenta')}` +
      `  ${c('JOY MEDIA CLI', 'bold')}` +
      ` ${c('v1.0.1', 'dim')}`,
  );
  console.log(
    `${c('  ╚══████╗██╔═══██╗╚██╗ ██╔╝', 'magenta')}` +
      `  ${c('Full-Power Joy Agent & Video Engine', 'cyan')}`,
  );
  console.log(
    `${c('  ██████╔╝╚██████╔╝ ╚████╔╝ ', 'magenta')}` +
      `  ${c('Local-first · Offline capable · RTX accelerated', 'dim')}\n`,
  );
}

/** Print one JSON document on stdout (the only thing stdout carries in machine mode). */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Print a plain human line (stdout, or stderr in machine output mode). */
export function logLine(msg = ''): void {
  human(msg);
}

export function logInfo(msg: string): void {
  human(`${paint('ℹ', 'cyan', humanStream())} ${msg}`);
}

export function logSuccess(msg: string): void {
  human(`${paint('✔', 'green', humanStream())} ${msg}`);
}

export function logWarn(msg: string): void {
  human(`${paint('▲', 'yellow', humanStream())} ${msg}`);
}

export function logError(msg: string): void {
  console.error(forStream(`${paint('✖', 'red', process.stderr)} ${msg}`, process.stderr));
}

export function logStep(label: string, detail: string): void {
  const stream = humanStream();
  human(`  ${paint('•', 'dim', stream)} ${paint(label, 'bold', stream)}: ${detail}`);
}

export function printTable(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      const len = row[i]?.length ?? 0;
      if (len > max) max = len;
    }
    return Math.max(max, 4);
  });

  const separator = colWidths.map((w) => '─'.repeat(w)).join('──┼──');
  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i]!)).join('  │  ');
  const stream = humanStream();

  human(`  ${paint(headerLine, 'bold', stream)}`);
  human(`  ${paint(separator, 'dim', stream)}`);

  for (const row of rows) {
    const rowLine = headers.map((_, i) => (row[i] ?? '').padEnd(colWidths[i]!)).join('  │  ');
    human(`  ${rowLine}`);
  }
}
