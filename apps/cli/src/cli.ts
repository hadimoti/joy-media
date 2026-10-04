/* global console, process */
import { parseArgs } from 'node:util';
import { handleAgentCommand } from './commands/agent-cmd.js';
import { handleAssetCommand } from './commands/asset-cmd.js';
import { handleBenchmarkCommand } from './commands/benchmark-cmd.js';
import { handleDoctorCommand } from './commands/doctor-cmd.js';
import { handleProjectCommand } from './commands/project-cmd.js';
import { handleRenderCommand } from './commands/render-cmd.js';
import { handleTimelineCommand } from './commands/timeline-cmd.js';
import { handleWorkerCommand } from './commands/worker-cmd.js';
import { printAgentHelp } from './commands/agent-cmd.js';
import { printTimelineHelp } from './commands/timeline-cmd.js';
import { printRenderHelp } from './commands/render-cmd.js';
import {
  FlagValidationError,
  NUMERIC_RANGES,
  parseFloatFlag,
  parseIntFlag,
} from './utils/flags.js';
import { c, logError, logWarn, printBanner } from './utils/logger.js';

export interface CliFlags {
  project: string | undefined;
  apply: boolean;
  allowFrames: boolean;
  vision: boolean;
  name: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  apiKey: string | undefined;
  apiKeyEnv: string | undefined;
  baseUrl: string | undefined;
  output: string | undefined;
  width: number | undefined;
  height: number | undefined;
  fps: number | undefined;
  track: string | undefined;
  clip: string | undefined;
  asset: string | undefined;
  text: string | undefined;
  x: number | undefined;
  y: number | undefined;
  size: number | undefined;
  color: string | undefined;
  id: string | undefined;
  strict: boolean;
  manifestOnly: boolean;
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
  debug: boolean;
  system: boolean;
  'media-engine': boolean;
}

export function printHelp(): void {
  printBanner();
  console.log(`  ${c('Usage:', 'bold')} joy-media <command> [subcommand] [options]\n`);
  console.log(`  ${c('Commands:', 'bold')}`);
  console.log(
    `    ${c('agent', 'cyan')} [chat|run|probe|config]    Full-power Joy Agent AI editing commands`,
  );
  console.log(
    `    ${c('project', 'cyan')} [list|create|show|export]  Local SQLite project management`,
  );
  console.log(
    `    ${c('timeline', 'cyan')} [add-clip|split|trim]     Direct scriptable timeline operations`,
  );
  console.log(
    `    ${c('asset', 'cyan')} [import|list]             Import and inspect local media assets`,
  );
  console.log(
    `    ${c('worker', 'cyan')} [status|upscale|denoise]    Local AI worker & GPU inference`,
  );
  console.log(
    `    ${c('render', 'cyan')} [--project --preset --out --concurrency --json]  Headless batch render`,
  );
  console.log(
    `    ${c('benchmark', 'cyan')} [--system --media-engine --json]                 Diagnostic & benchmark suite`,
  );
  console.log(
    `    ${c('doctor', 'cyan')}                            System health check & diagnostics`,
  );
  console.log(`    ${c('help', 'cyan')}                              Show this help guide\n`);
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

function parseFlags(rawValues: Record<string, unknown>): CliFlags {
  const v = rawValues as Record<string, string | boolean | undefined>;
  return {
    project: typeof v.project === 'string' ? v.project : undefined,
    apply: Boolean(v.apply),
    allowFrames: Boolean(v['allow-frames']),
    vision: Boolean(v.vision),
    name: typeof v.name === 'string' ? v.name : undefined,
    provider: typeof v.provider === 'string' ? v.provider : undefined,
    model: typeof v.model === 'string' ? v.model : undefined,
    apiKey: typeof v['api-key'] === 'string' ? v['api-key'] : undefined,
    apiKeyEnv: typeof v['api-key-env'] === 'string' ? v['api-key-env'] : undefined,
    baseUrl:
      typeof v['base-url'] === 'string'
        ? v['base-url']
        : typeof v.url === 'string'
          ? v.url
          : undefined,
    output: typeof v.output === 'string' ? v.output : undefined,
    width: parseIntFlag('width', v.width, NUMERIC_RANGES.width),
    height: parseIntFlag('height', v.height, NUMERIC_RANGES.height),
    fps: parseIntFlag('fps', v.fps, NUMERIC_RANGES.fps),
    track: typeof v.track === 'string' ? v.track : undefined,
    clip: typeof v.clip === 'string' ? v.clip : undefined,
    asset: typeof v.asset === 'string' ? v.asset : undefined,
    text: typeof v.text === 'string' ? v.text : undefined,
    x: parseFloatFlag('x', v.x, { min: -32768, max: 32768 }),
    y: parseFloatFlag('y', v.y, { min: -32768, max: 32768 }),
    size: parseIntFlag('size', v.size, { min: 1, max: 512, allowZero: false }),
    color: typeof v.color === 'string' ? v.color : undefined,
    id: typeof v.id === 'string' ? v.id : undefined,
    strict: Boolean(v.strict),
    manifestOnly: Boolean(v['manifest-only']),
    start: parseFloatFlag('start', v.start, NUMERIC_RANGES.start),
    duration: parseFloatFlag('duration', v.duration, NUMERIC_RANGES.duration),
    end: parseFloatFlag('end', v.end, NUMERIC_RANGES.end),
    at: parseFloatFlag('at', v.at, NUMERIC_RANGES.at),
    scale: parseIntFlag('scale', v.scale, NUMERIC_RANGES.scale),
    sqlitePath: typeof v['sqlite-path'] === 'string' ? v['sqlite-path'] : undefined,
    preset: typeof v.preset === 'string' ? v.preset : undefined,
    out: typeof v.out === 'string' ? v.out : undefined,
    concurrency: parseIntFlag('concurrency', v.concurrency, {
      min: 1,
      max: 32,
      allowZero: false,
    }),
    json: Boolean(v.json),
    debug: Boolean(v.debug),
    system: Boolean(v.system),
    'media-engine': Boolean(v['media-engine']),
  };
}

export async function runCli(argv: string[]): Promise<number> {
  let parsedArgs;
  try {
    parsedArgs = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        project: { type: 'string', short: 'p' },
        apply: { type: 'boolean', default: false },
        'allow-frames': { type: 'boolean', default: false },
        vision: { type: 'boolean', default: false },
        name: { type: 'string', short: 'n' },
        provider: { type: 'string' },
        model: { type: 'string', short: 'm' },
        'api-key': { type: 'string' },
        'api-key-env': { type: 'string' },
        'base-url': { type: 'string' },
        url: { type: 'string', short: 'u' },
        output: { type: 'string', short: 'o' },
        width: { type: 'string' },
        height: { type: 'string' },
        fps: { type: 'string' },
        track: { type: 'string' },
        clip: { type: 'string' },
        asset: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'string' },
        y: { type: 'string' },
        size: { type: 'string' },
        color: { type: 'string' },
        id: { type: 'string' },
        strict: { type: 'boolean', default: false },
        'manifest-only': { type: 'boolean', default: false },
        start: { type: 'string' },
        duration: { type: 'string' },
        end: { type: 'string' },
        at: { type: 'string' },
        scale: { type: 'string' },
        'sqlite-path': { type: 'string' },
        preset: { type: 'string' },
        out: { type: 'string' },
        concurrency: { type: 'string' },
        json: { type: 'boolean', default: false },
        debug: { type: 'boolean', default: false },
        system: { type: 'boolean', default: false },
        'media-engine': { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch (err) {
    logError(`Failed to parse CLI arguments: ${formatError(err)}`);
    return 2;
  }

  const { values, positionals } = parsedArgs;

  if (values.version) {
    console.log('JOY Media CLI v1.0.1');
    return 0;
  }

  if (values.help) {
    const helpCommand = positionals[0];
    if (helpCommand === 'agent') printAgentHelp();
    else if (helpCommand === 'timeline') printTimelineHelp();
    else if (helpCommand === 'render') printRenderHelp();
    else if (helpCommand === 'asset')
      console.log('Usage: joy-media asset <import|list> --project <id|file>');
    else printHelp();
    return 0;
  }

  if (positionals.length === 0) {
    printHelp();
    return 0;
  }

  const [command, ...subArgs] = positionals;

  let flags: CliFlags;
  try {
    flags = parseFlags(values as Record<string, unknown>);
  } catch (err) {
    if (err instanceof FlagValidationError) {
      logError(err.message);
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
      case 'asset':
        return await handleAssetCommand(subArgs, flags);
      case 'worker':
        return await handleWorkerCommand(subArgs, flags);
      case 'render':
        return await handleRenderCommand(subArgs, flags);
      case 'benchmark':
        return await handleBenchmarkCommand(subArgs, flags);
      case 'doctor':
        return await handleDoctorCommand();
      case 'login':
        logWarn(
          'Interactive JOY login is not implemented yet. Set JOY_MEDIA_SESSION_TOKEN to use the hosted provider.',
        );
        return 1;
      case 'help':
        printHelp();
        return 0;
      default:
        logError(`Unknown command "${command}". Run ${c('joy-media help', 'cyan')} for usage.`);
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
  if (err instanceof FlagValidationError) {
    logError(err.message);
    return 2;
  }
  const ctx = context ? ` (during "${context}")` : '';
  logError(`Unexpected error${ctx}: ${formatError(err)}`);
  if (process.env.JOY_CLI_DEBUG && err instanceof Error && err.stack) {
    logWarn(err.stack);
  }
  return 1;
}
