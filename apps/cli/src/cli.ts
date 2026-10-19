/* global console, process */
import { handleAgentCommand } from './commands/agent-cmd.js';
import { handleBenchmarkCommand } from './commands/benchmark-cmd.js';
import { handleDoctorCommand } from './commands/doctor-cmd.js';
import { handleProjectCommand } from './commands/project-cmd.js';
import { handleRenderCommand } from './commands/render-cmd.js';
import { handleTimelineCommand } from './commands/timeline-cmd.js';
import { handleWorkerCommand } from './commands/worker-cmd.js';
import { trackLongRunning } from './long-running.js';
import {
  type CliOptionSpec,
  NUMERIC_RANGES,
  UsageError,
  parseCommandLine,
  parseFloatFlag,
  parseIntFlag,
  suggest,
} from './utils/flags.js';
import { c, logError, printBanner, printJson, setMachineOutput } from './utils/logger.js';

export const CLI_VERSION = '1.0.2';

export interface CliFlags {
  project: string | undefined;
  apply: boolean;
  name: string | undefined;
  family: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  output: string | undefined;
  width: number | undefined;
  height: number | undefined;
  fps: number | undefined;
  track: string | undefined;
  clip: string | undefined;
  asset: string | undefined;
  start: number | undefined;
  duration: number | undefined;
  end: number | undefined;
  at: number | undefined;
  scale: number | undefined;
  sqlitePath: string | undefined;
  preset: string | undefined;
  out: string | undefined;
  concurrency: number | undefined;
  json: boolean;
  system: boolean;
  'media-engine': boolean;
  manifestOnly?: boolean;
  allowExtend?: boolean;
  mediaDir?: string | undefined;
}

/**
 * Every option any command reads. Options are global (accepted before or after
 * the command); anything not listed here is a usage error (exit 2), so a new
 * flag MUST be declared here before a command can read it.
 */
export const CLI_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  project: { type: 'string', short: 'p' },
  apply: { type: 'boolean' },
  'allow-extend': { type: 'boolean' },
  name: { type: 'string', short: 'n' },
  family: { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string', short: 'm' },
  'api-key': { type: 'string' },
  'base-url': { type: 'string' },
  url: { type: 'string', short: 'u' },
  output: { type: 'string', short: 'o' },
  width: { type: 'string', numeric: true },
  height: { type: 'string', numeric: true },
  fps: { type: 'string', numeric: true },
  track: { type: 'string' },
  clip: { type: 'string' },
  asset: { type: 'string' },
  start: { type: 'string', numeric: true },
  duration: { type: 'string', numeric: true },
  end: { type: 'string', numeric: true },
  at: { type: 'string', numeric: true },
  scale: { type: 'string', numeric: true },
  'sqlite-path': { type: 'string' },
  preset: { type: 'string' },
  out: { type: 'string' },
  concurrency: { type: 'string', numeric: true },
  system: { type: 'boolean' },
  'media-engine': { type: 'boolean' },
  'manifest-only': { type: 'boolean' },
  'media-dir': { type: 'string' },
} as const satisfies Record<string, CliOptionSpec>;

interface CommandHelp {
  readonly summary: string;
  readonly usage: string;
  readonly subcommands?: ReadonlyArray<readonly [string, string]>;
  readonly options?: ReadonlyArray<readonly [string, string]>;
  readonly notes?: readonly string[];
}

const COMMAND_HELP: Readonly<Record<string, CommandHelp>> = {
  agent: {
    summary: 'Full-power Joy Agent AI editing commands',
    usage: 'joy-media agent <subcommand> [options]',
    subcommands: [
      ['chat', 'Interactive Joy Agent REPL (default; needs a terminal)'],
      ['run "<instruction>"', 'One-shot agent edit of a project'],
      ['probe', 'Check the configured LLM provider capabilities'],
      ['config', 'Show or update the agent configuration'],
      ['provider [list|add|use|remove] <name>', 'Manage AI providers'],
      ['model [get|set <model-id>]', 'Show or set the default model'],
      ['models [provider]', 'List models offered by a provider (network)'],
    ],
    options: [
      ['--project, -p <id|file.json>', 'Target project (default: newest)'],
      ['--apply', 'Commit agent changes to the project'],
      ['--provider <name>', 'Provider override'],
      ['--model, -m <id>', 'Model override'],
      ['--api-key <key>', 'API key override'],
      ['--url, -u <url> / --base-url <url>', 'Provider base URL'],
      ['--name, -n <name>', 'Provider name (provider add/use/remove)'],
      ['--json', 'Machine-readable output where supported'],
    ],
  },
  project: {
    summary: 'Local SQLite project management',
    usage: 'joy-media project <subcommand> [options]',
    subcommands: [
      ['list', 'List local projects (default)'],
      ['create <title...>', 'Create a project'],
      ['show <id|file.json>', 'Show tracks and clips'],
      ['export <id>', 'Export a project to JSON'],
      ['import <file.json>', 'Import a project from JSON'],
    ],
    options: [
      ['--width <px> --height <px> --fps <n>', 'Canvas settings for create'],
      ['--output, -o <file.json>', 'Export destination'],
      ['--sqlite-path <path>', 'Project database (default: the desktop project store; see doctor)'],
      ['--json', 'Machine-readable output where supported'],
    ],
  },
  timeline: {
    summary: 'Direct scriptable timeline operations',
    usage: 'joy-media timeline <subcommand> --project <id> [options]',
    subcommands: [
      ['add-clip', 'Add a clip (--track --asset --start --duration)'],
      ['split', 'Split a clip (--clip --at)'],
      ['trim', 'Trim a clip (--clip --start --end|--duration)'],
      ['remove-clip', 'Remove a clip (--clip)'],
      ['add-track', 'Add an empty track (--family visual|audio [--name])'],
      ['move', 'Move a clip in time, or to another track (--clip [--start] [--track])'],
    ],
    options: [
      ['--project, -p <id|file.json>', 'Target project (required)'],
      ['--track <id> --clip <id> --asset <id>', 'Targets'],
      ['--start <s> --end <s> --at <s>', 'Timeline positions in seconds (>= 0)'],
      ['--duration <s>', 'Clip length in seconds (>= 0.001)'],
      ['--allow-extend', 'add-clip: allow a clip longer than its source media'],
      ['--family <visual|audio>', 'add-track: the kind of track to add'],
      ['--sqlite-path <path>', 'Project database'],
    ],
  },
  worker: {
    summary: 'Local AI worker & GPU inference',
    usage: 'joy-media worker <subcommand> [options]',
    subcommands: [
      ['status', 'GPU, AI environments and model weights (default)'],
      ['upscale <input-image>', 'RealESRGAN upscale (--scale 1-16, default 4)'],
      ['denoise <input-audio>', 'DeepFilterNet noise reduction'],
    ],
    options: [
      ['--scale <n>', 'Upscale factor, integer 1-16'],
      ['--output, -o <file>', 'Output file (default: <input>-upscaled-4x.<ext>)'],
      ['--json', 'One JSON document on stdout'],
    ],
    notes: ['Environment: JOY_MODELS_DIR overrides the model weights directory.'],
  },
  render: {
    summary: 'Headless batch render',
    usage: 'joy-media render --project <id|file.json> [options]',
    options: [
      ['--project, -p <id|file.json>', 'Project to render (required)'],
      ['--preset <mp4|webm|prores>', 'Output preset (default mp4)'],
      ['--out <dir>', 'Output directory (default ./renders)'],
      ['--concurrency <1-32>', 'Parallel clips (manifest-only mode; default 2)'],
      ['--media-dir <dir>', "Folder holding the media files the project's assets name"],
      ['--manifest-only', 'Write only the plan manifest; encode no video'],
      ['--sqlite-path <path>', 'Project database'],
      ['--json', 'Newline-delimited JSON progress events'],
    ],
  },
  benchmark: {
    summary: 'Diagnostic & benchmark suite',
    usage: 'joy-media benchmark [options]',
    options: [
      ['--system', 'Disk I/O, SQLite and heap benchmarks'],
      ['--media-engine', 'Timeline scrub, collision and look benchmarks'],
      ['--json', 'Newline-delimited JSON measurements'],
    ],
  },
  doctor: {
    summary: 'System health check & diagnostics',
    usage: 'joy-media doctor [--json]',
    options: [['--json', 'One JSON document: { ok, summary, checks[] }']],
    notes: [
      'Exit code 1 when a check fails; warnings (optional features missing) exit 0.',
      'Environment: JOY_MEDIA_EDGE_URL=<url>|off sets or disables the edge connectivity probe;',
      'JOY_MODELS_DIR overrides the model weights directory.',
    ],
  },
  help: {
    summary: 'Show help for the CLI or one command',
    usage: 'joy-media help [command]',
  },
};

const COMMANDS = Object.keys(COMMAND_HELP);

export function printHelp(): void {
  printBanner();
  console.log(`  ${c('Usage:', 'bold')} joy-media <command> [subcommand] [options]\n`);
  console.log(`  ${c('Commands:', 'bold')}`);
  console.log(
    `    ${c('agent', 'cyan')} [chat|run|probe|config|provider|model]  Full-power Joy Agent AI editing commands`,
  );
  console.log(
    `    ${c('project', 'cyan')} [list|create|show|export|import]   Local SQLite project management`,
  );
  console.log(
    `    ${c('timeline', 'cyan')} [add-clip|split|trim|remove-clip] Direct scriptable timeline operations`,
  );
  console.log(
    `    ${c('worker', 'cyan')} [status|upscale|denoise]            Local AI worker & GPU inference`,
  );
  console.log(
    `    ${c('render', 'cyan')} [--project --preset --out --concurrency --json]  Headless batch render`,
  );
  console.log(
    `    ${c('benchmark', 'cyan')} [--system --media-engine --json]                 Diagnostic & benchmark suite`,
  );
  console.log(
    `    ${c('doctor', 'cyan')} [--json]                            System health check & diagnostics`,
  );
  console.log(
    `    ${c('help', 'cyan')} [command]                             Show this help guide or a command's help\n`,
  );
  console.log(`  ${c('Global options:', 'bold')}`);
  console.log(`    --json           Machine output: stdout carries only JSON, logs go to stderr`);
  console.log(`    --help, -h       Show help (also: joy-media <command> --help)`);
  console.log(`    --version, -v    Print the CLI version\n`);
  console.log(`  ${c('Exit codes:', 'bold')} 0 ok · 1 failure · 2 usage error · 130 interrupted\n`);
  console.log(`  ${c('Examples:', 'bold')}`);
  console.log(
    `    ${c('joy-media agent chat', 'dim')}                          # Launch interactive Joy Agent REPL`,
  );
  console.log(
    `    ${c('joy-media agent run "split intro clip" --apply', 'dim')}# Run one-shot agent command`,
  );
  console.log(
    `    ${c('joy-media project list', 'dim')}                        # List all desktop projects`,
  );
  console.log(
    `    ${c('joy-media worker status', 'dim')}                       # Check RTX GPU and models`,
  );
  console.log(
    `    ${c('joy-media doctor', 'dim')}                              # Verify system environment\n`,
  );
}

/** Help for one command. Returns false if `command` is not a known command. */
export function printCommandHelp(command: string): boolean {
  const help = Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : undefined;
  if (!help) return false;
  const pad = (rows: ReadonlyArray<readonly [string, string]>): number =>
    Math.max(...rows.map(([left]) => left.length)) + 2;
  console.log(`${c('Usage:', 'bold')} ${help.usage}\n`);
  console.log(`${help.summary}\n`);
  if (help.subcommands?.length) {
    const width = pad(help.subcommands);
    console.log(c('Subcommands:', 'bold'));
    for (const [left, right] of help.subcommands) {
      console.log(`  ${c(left.padEnd(width), 'cyan')}${right}`);
    }
    console.log();
  }
  const options: ReadonlyArray<readonly [string, string]> = [
    ...(help.options ?? []),
    ['--help, -h', 'Show this help'],
  ];
  const width = pad(options);
  console.log(c('Options:', 'bold'));
  for (const [left, right] of options) {
    console.log(`  ${left.padEnd(width)}${right}`);
  }
  for (const note of help.notes ?? []) console.log(`\n${note}`);
  console.log();
  return true;
}

function parseFlags(v: Record<string, string | boolean | undefined>): CliFlags {
  const str = (key: string): string | undefined =>
    typeof v[key] === 'string' ? (v[key] as string) : undefined;
  return {
    project: str('project'),
    apply: v.apply === true,
    name: str('name'),
    family: str('family'),
    provider: str('provider'),
    model: str('model'),
    apiKey: str('api-key'),
    baseUrl: str('base-url') ?? str('url'),
    output: str('output'),
    width: parseIntFlag('width', v.width, NUMERIC_RANGES.width),
    height: parseIntFlag('height', v.height, NUMERIC_RANGES.height),
    fps: parseIntFlag('fps', v.fps, NUMERIC_RANGES.fps),
    track: str('track'),
    clip: str('clip'),
    asset: str('asset'),
    start: parseFloatFlag('start', v.start, NUMERIC_RANGES.start),
    duration: parseFloatFlag('duration', v.duration, NUMERIC_RANGES.duration),
    end: parseFloatFlag('end', v.end, NUMERIC_RANGES.end),
    at: parseFloatFlag('at', v.at, NUMERIC_RANGES.at),
    scale: parseIntFlag('scale', v.scale, NUMERIC_RANGES.scale),
    sqlitePath: str('sqlite-path'),
    preset: str('preset'),
    out: str('out'),
    concurrency: parseIntFlag('concurrency', v.concurrency, {
      min: 1,
      max: 32,
      allowZero: false,
    }),
    json: v.json === true,
    system: v.system === true,
    'media-engine': v['media-engine'] === true,
    manifestOnly: v['manifest-only'] === true,
    allowExtend: v['allow-extend'] === true,
    mediaDir: str('media-dir'),
  };
}

/** `<message>. Run "joy-media <command> --help" for usage.` */
function withUsageHint(message: string, command: string | undefined): string {
  const known = command !== undefined && Object.hasOwn(COMMAND_HELP, command);
  const sentence = /[.?!]$/.test(message) ? message : `${message}.`;
  return `${sentence} Run "joy-media ${known ? `${command} ` : ''}--help" for usage.`;
}

function reportUsageError(command: string | undefined, message: string, json: boolean): void {
  const detail = withUsageHint(message, command);
  if (!json) {
    logError(detail);
    return;
  }
  // Same envelope as every other --json failure: {type, code, message}. `render --json` is
  // an NDJSON stream, so its single error line is the same document as everywhere else.
  console.log(JSON.stringify({ type: 'error', code: 'usage_error', message: detail }));
}

function unknownCommandMessage(command: string): string {
  const guess = suggest(command, COMMANDS);
  const hint = guess ? ` Did you mean "${guess}"?` : '';
  return `Unknown command "${command}".${hint} Run ${c('joy-media help', 'cyan')} for usage.`;
}

export async function runCli(argv: string[]): Promise<number> {
  setMachineOutput(false);
  try {
    return await dispatch(argv);
  } finally {
    setMachineOutput(false);
  }
}

async function dispatch(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCommandLine(argv, CLI_OPTIONS);
  } catch (err) {
    logError(`Failed to parse CLI arguments: ${formatError(err)}`);
    return 2;
  }

  const { values, positionals } = parsed;
  setMachineOutput(values.json === true);
  const [command, ...subArgs] = positionals;

  if (parsed.version) {
    if (values.json === true) printJson({ name: 'joy-media', version: CLI_VERSION });
    else console.log(`JOY Media CLI v${CLI_VERSION}`);
    return 0;
  }

  if (parsed.help) {
    // `help project --help` -> project's help; `help --help` -> help's own help.
    const target = command === 'help' ? (subArgs[0] ?? 'help') : command;
    if (target === undefined || !printCommandHelp(target)) printHelp();
    return 0;
  }

  if (parsed.error) {
    reportUsageError(command, parsed.error.message, values.json === true);
    return 2;
  }

  if (command === undefined) {
    printHelp();
    return 0;
  }

  let flags: CliFlags;
  try {
    flags = parseFlags(values);
  } catch (err) {
    if (err instanceof UsageError) {
      reportUsageError(command, err.message, values.json === true);
      if (process.env.JOY_CLI_DEBUG) {
        console.error(err.stack);
      }
      return 2;
    }
    throw err;
  }

  try {
    switch (command) {
      case 'agent':
        return await handleAgentCommand(subArgs, flags);
      case 'project':
        return await handleProjectCommand(subArgs, flags);
      case 'timeline':
        return await handleTimelineCommand(subArgs, flags);
      case 'worker':
        return await handleWorkerCommand(subArgs, flags);
      case 'render':
        return await trackLongRunning(() => handleRenderCommand(subArgs, flags));
      case 'benchmark':
        return await handleBenchmarkCommand(subArgs, flags);
      case 'doctor':
        return await handleDoctorCommand(subArgs, flags);
      case 'help': {
        const target = subArgs[0];
        if (target === undefined) {
          printHelp();
          return 0;
        }
        if (printCommandHelp(target)) return 0;
        logError(unknownCommandMessage(target));
        return 1;
      }
      default:
        logError(unknownCommandMessage(command));
        return 1;
    }
  } catch (err) {
    return handleUnhandledError(err, command);
  }
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.stack && process.env.JOY_CLI_DEBUG) {
      return `${err.message}\n${err.stack}`;
    }
    return err.message || err.name;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function handleUnhandledError(err: unknown, context?: string): number {
  if (err instanceof UsageError) {
    logError(err.message);
    return 2;
  }
  const ctx = context ? ` (during "${context}")` : '';
  // With JOY_CLI_DEBUG, formatError() appends the stack. Diagnostics belong on
  // stderr: stdout may be a JSON stream.
  logError(`Unexpected error${ctx}: ${formatError(err)}`);
  return 1;
}
