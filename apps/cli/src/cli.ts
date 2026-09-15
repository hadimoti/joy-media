/* global console */
import { parseArgs } from 'node:util';
import { handleAgentCommand } from './commands/agent-cmd.js';
import { handleDoctorCommand } from './commands/doctor-cmd.js';
import { handleProjectCommand } from './commands/project-cmd.js';
import { handleTimelineCommand } from './commands/timeline-cmd.js';
import { handleWorkerCommand } from './commands/worker-cmd.js';
import { c, logError, printBanner } from './utils/logger.js';

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
    `    ${c('worker', 'cyan')} [status|upscale|denoise]    Local AI worker & GPU inference`,
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

export async function runCli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      project: { type: 'string', short: 'p' },
      apply: { type: 'boolean', default: false },
      provider: { type: 'string' },
      model: { type: 'string', short: 'm' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },
      output: { type: 'string', short: 'o' },
      width: { type: 'string' },
      height: { type: 'string' },
      fps: { type: 'string' },
      track: { type: 'string' },
      clip: { type: 'string' },
      asset: { type: 'string' },
      start: { type: 'string' },
      duration: { type: 'string' },
      end: { type: 'string' },
      at: { type: 'string' },
      scale: { type: 'string' },
      'sqlite-path': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.version) {
    console.log('JOY Media CLI v1.0.0');
    return 0;
  }

  if (values.help || positionals.length === 0) {
    printHelp();
    return 0;
  }

  const [command, ...subArgs] = positionals;

  const flags = {
    project: values.project as string | undefined,
    apply: Boolean(values.apply),
    provider: values.provider as string | undefined,
    model: values.model as string | undefined,
    apiKey: values['api-key'] as string | undefined,
    baseUrl: values['base-url'] as string | undefined,
    output: values.output as string | undefined,
    width: values.width ? parseInt(values.width as string, 10) : undefined,
    height: values.height ? parseInt(values.height as string, 10) : undefined,
    fps: values.fps ? parseInt(values.fps as string, 10) : undefined,
    track: values.track as string | undefined,
    clip: values.clip as string | undefined,
    asset: values.asset as string | undefined,
    start: values.start ? parseFloat(values.start as string) : undefined,
    duration: values.duration ? parseFloat(values.duration as string) : undefined,
    end: values.end ? parseFloat(values.end as string) : undefined,
    at: values.at ? parseFloat(values.at as string) : undefined,
    scale: values.scale ? parseInt(values.scale as string, 10) : undefined,
    sqlitePath: values['sqlite-path'] as string | undefined,
  };

  switch (command) {
    case 'agent':
      return await handleAgentCommand(subArgs, flags);
    case 'project':
      return await handleProjectCommand(subArgs, flags);
    case 'timeline':
      return await handleTimelineCommand(subArgs, flags);
    case 'worker':
      return await handleWorkerCommand(subArgs, flags);
    case 'doctor':
      return await handleDoctorCommand();
    case 'help':
      printHelp();
      return 0;
    default:
      logError(`Unknown command "${command}". Run ${c('joy-media help', 'cyan')} for usage.`);
      return 1;
  }
}
