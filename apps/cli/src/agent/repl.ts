/* global console, process */
import * as readline from 'node:readline/promises';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { c, logInfo, logSuccess, logWarn, printBanner } from '../utils/logger.js';
import { saveProject } from '../utils/project-loader.js';
import { runJoyAgent } from './joy-agent.js';
import type { ResolveProviderOptions } from './provider.js';

export interface ReplOptions {
  project: JoyProjectV1;
  revision: number;
  source: 'sqlite' | 'file';
  path: string;
  providerOptions?: ResolveProviderOptions;
}

export async function startAgentRepl(options: ReplOptions): Promise<void> {
  printBanner();
  console.log(
    `  ${c('Project:', 'bold')} ${options.project.title} (${c(options.project.id, 'cyan')})  ${c('Rev:', 'bold')} ${options.revision}`,
  );
  console.log(`  ${c('Source:', 'bold')}  ${options.path} [${options.source}]`);
  console.log(
    `  ${c('Type', 'dim')} ${c('/help', 'bold')} ${c('for commands, or ask Joy Agent in natural language.', 'dim')}\n`,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let currentProject = options.project;
  let currentRev = options.revision;

  try {
    while (true) {
      const input = await rl.question(`${c('joy-agent', 'magenta')}> `);
      const trimmed = input.trim();

      if (!trimmed) continue;

      if (trimmed === '/exit' || trimmed === '/quit' || trimmed === ':q') {
        console.log(c('Goodbye!', 'dim'));
        break;
      }

      if (trimmed === '/help') {
        console.log(`\n  ${c('Interactive Joy Agent Commands:', 'bold')}`);
        console.log(`    ${c('/project', 'cyan')}      Show current project status & tracks`);
        console.log(`    ${c('/save', 'cyan')}         Save project snapshot`);
        console.log(`    ${c('/exit', 'cyan')}         Exit interactive REPL`);
        console.log(
          `    ${c('<prompt>', 'yellow')}       Natural language request (e.g. "split first video clip in half")\n`,
        );
        continue;
      }

      if (trimmed === '/project') {
        const root = currentProject.compositions[currentProject.rootCompositionId];
        console.log(
          `\n  ${c('Title:', 'bold')} ${currentProject.title} | ${c('Rev:', 'bold')} ${currentRev}`,
        );
        console.log(`  ${c('Tracks:', 'bold')} ${root?.tracks.length ?? 0}`);
        for (const track of root?.tracks ?? []) {
          console.log(
            `    ${c(track.name ?? track.id, 'cyan')} [${track.family ?? 'visual'}]: ${track.clips.length} clip(s)`,
          );
        }
        console.log();
        continue;
      }

      if (trimmed === '/save') {
        currentRev = saveProject(currentProject, {
          source: options.source,
          path: options.path,
          revision: currentRev,
        });
        logSuccess(`Project saved at revision ${currentRev}.`);
        continue;
      }

      // Run Joy Agent
      try {
        const result = await runJoyAgent({
          project: currentProject,
          revision: currentRev,
          prompt: trimmed,
          apply: false,
          providerOptions: options.providerOptions,
        });

        const totalStaged = result.staged.timelineOps.length + result.staged.documentOps.length;

        if (totalStaged > 0) {
          console.log(`\n  ${c('Proposed Modifications:', 'bold')}`);
          for (const op of result.staged.timelineOps) {
            console.log(
              `    ${c('+', 'green')} Timeline: ${c(op.kind, 'bold')} on track ${op.kind === 'insert' || op.kind === 'move' ? (op as { trackId: string }).trackId : 'current'}`,
            );
          }
          for (const op of result.staged.documentOps) {
            console.log(
              `    ${c('+', 'green')} Document: ${c(op.kind, 'bold')} object ${(op as { objectId: string }).objectId}`,
            );
          }

          const answer = await rl.question(
            `\n  ${c('Apply these changes to project? [y/N]:', 'yellow')} `,
          );
          if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
            const applied = await runJoyAgent({
              project: currentProject,
              revision: currentRev,
              prompt: trimmed,
              apply: true,
              providerOptions: options.providerOptions,
            });
            currentProject = applied.updatedProject;
            currentRev = saveProject(currentProject, {
              source: options.source,
              path: options.path,
              revision: currentRev,
            });
            logSuccess(`Saved updated project revision ${currentRev}.`);
          } else {
            logInfo('Changes discarded.');
          }
        }
      } catch (err) {
        logWarn(`Joy Agent run error: ${String(err)}`);
      }
      console.log();
    }
  } finally {
    rl.close();
  }
}
