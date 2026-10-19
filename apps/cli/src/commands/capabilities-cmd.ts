/* global console */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_VERSION, COMMAND_HELP, printCommandHelp } from '../cli.js';
import { c, printJson } from '../utils/logger.js';
import { buildFeatureList, type FeatureEntry } from './render-features.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandEntry {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly subcommands: readonly string[];
  readonly status: 'available';
}

export interface CapabilitiesDocument {
  readonly schemaVersion: string;
  readonly cli: { readonly name: string; readonly version: string };
  readonly commands: readonly CommandEntry[];
  readonly features: readonly FeatureEntry[];
}

// ---------------------------------------------------------------------------
// Build capabilities
// ---------------------------------------------------------------------------

/** Load the version from package.json. */
function readPackageVersion(): string {
  try {
    // Resolve the caller's package.json (apps/cli/package.json)
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(dir, '../../package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? CLI_VERSION;
  } catch {
    return CLI_VERSION;
  }
}

function buildCommands(): CommandEntry[] {
  const keys = Object.keys(COMMAND_HELP);
  return keys.map((name) => {
    const help = COMMAND_HELP[name]!;
    return {
      name,
      summary: help.summary,
      usage: help.usage,
      subcommands: (help.subcommands ?? []).map(([sub]) => sub),
      status: 'available' as const,
    };
  });
}

function buildDocument(): CapabilitiesDocument {
  return {
    schemaVersion: '1',
    cli: { name: 'joy-media', version: readPackageVersion() },
    commands: buildCommands(),
    features: buildFeatureList(),
  };
}

// ---------------------------------------------------------------------------
// Human output
// ---------------------------------------------------------------------------

function padEnd(s: string, len: number): string {
  return s + ' '.repeat(Math.max(0, len - s.length));
}

function printHumanTable(doc: CapabilitiesDocument): void {
  console.log(`${c('JOY Media CLI', 'bold')} v${doc.cli.version}\n`);

  // Commands table
  console.log(`${c('Commands:', 'bold')}`);
  const cmdNameW = Math.max(...doc.commands.map((c) => c.name.length)) + 2;
  const cmdSummaryW = Math.max(...doc.commands.map((c) => c.summary.length)) + 2;
  console.log(`  ${padEnd('Name', cmdNameW)} ${padEnd('Summary', cmdSummaryW)} Status`);
  console.log(`  ${'-'.repeat(cmdNameW - 2)} ${'-'.repeat(cmdSummaryW - 2)} ------`);
  for (const cmd of doc.commands) {
    console.log(
      `  ${padEnd(cmd.name, cmdNameW)} ${padEnd(cmd.summary, cmdSummaryW)} ${c('available', 'green')}`,
    );
  }
  console.log();

  // Features table
  console.log(`${c('Features:', 'bold')}`);
  const featIdW = Math.max(...doc.features.map((f) => f.id.length)) + 2;
  const featAreaW = Math.max(...doc.features.map((f) => f.area.length)) + 2;
  console.log(
    `  ${padEnd('ID', featIdW)} ${padEnd('Area', featAreaW)} Status${' '.repeat(14)} Reason`,
  );
  console.log(
    `  ${'-'.repeat(featIdW - 2)} ${'-'.repeat(featAreaW - 2)} ${'-'.repeat(14)} ${'-'.repeat(40)}`,
  );
  for (const feat of doc.features) {
    const statusColor =
      feat.status === 'available' ? 'green' : feat.status === 'setup-required' ? 'yellow' : 'red';
    console.log(
      `  ${padEnd(feat.id, featIdW)} ${padEnd(feat.area, featAreaW)} ${padEnd(c(feat.status, statusColor), 14)} ${feat.reason}`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleCapabilitiesCommand(
  args: string[],
  flags: { json: boolean },
): Promise<number> {
  if (args.length > 0 && args[0] !== undefined) {
    const sub = args[0];
    if (sub === '--help' || sub === '-h') {
      printCommandHelp('capabilities');
      return 0;
    }
    console.error(`Unexpected argument "${sub}". Usage: joy-media capabilities [--json]`);
    return 2;
  }

  const doc = buildDocument();

  if (flags.json) {
    printJson(doc);
  } else {
    printHumanTable(doc);
  }

  return 0;
}
