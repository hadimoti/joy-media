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

const useColors = process.stdout.isTTY ?? false;

export function c(text: string, color: keyof typeof colors): string {
  if (!useColors) return text;
  return `${colors[color]}${text}${colors.reset}`;
}

export function printBanner(): void {
  console.log(
    `${c('  ██████╗  ██████╗ ██╗   ██╗', 'magenta')}` +
      `  ${c('JOY MEDIA CLI', 'bold')}` +
      ` ${c('v1.0.0', 'dim')}`,
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

export function logInfo(msg: string): void {
  console.log(`${c('ℹ', 'cyan')} ${msg}`);
}

export function logSuccess(msg: string): void {
  console.log(`${c('✔', 'green')} ${msg}`);
}

export function logWarn(msg: string): void {
  console.log(`${c('▲', 'yellow')} ${msg}`);
}

export function logError(msg: string): void {
  console.error(`${c('✖', 'red')} ${msg}`);
}

export function logStep(label: string, detail: string): void {
  console.log(`  ${c('•', 'dim')} ${c(label, 'bold')}: ${detail}`);
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

  console.log(`  ${c(headerLine, 'bold')}`);
  console.log(`  ${c(separator, 'dim')}`);

  for (const row of rows) {
    const rowLine = headers.map((_, i) => (row[i] ?? '').padEnd(colWidths[i]!)).join('  │  ');
    console.log(`  ${rowLine}`);
  }
}
