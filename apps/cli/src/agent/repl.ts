/* global console, process */
import * as readline from 'node:readline/promises';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { compileLook, editorialClean } from '@joy-media/motion-core';
import { c, logInfo, logSuccess, logWarn, printBanner, printTable } from '../utils/logger.js';
import { saveProject } from '../utils/project-loader.js';
import { runJoyAgent } from './joy-agent.js';
import type { ResolveProviderOptions } from './provider.js';

export interface ReplOptions {
  project: JoyProjectV1;
  revision: number;
  source: 'sqlite' | 'file';
  path: string;
  providerOptions?: ResolveProviderOptions;
  allowFrames?: boolean;
}

export interface DualBrainStatus {
  readonly workhorse: { readonly name: string; readonly provider: string; readonly model: string };
  readonly creative: { readonly name: string; readonly provider: string; readonly model: string };
}

export function saveReplProject(
  project: JoyProjectV1,
  options: ReplOptions,
  revision: number,
): number {
  if (options.path === 'in-memory') {
    logWarn('Changes exist only in this scratch session; nothing was saved.');
    return revision;
  }
  return saveProject(project, {
    source: options.source,
    path: options.path,
    revision,
  });
}

export const DUAL_BRAIN_STATUS: DualBrainStatus = {
  workhorse: {
    name: 'Workhorse',
    provider: 'openrouter',
    model: 'openrouter/free',
  },
  creative: {
    name: 'Creative Brain',
    provider: 'kilo',
    model: 'kilo-auto/efficient',
  },
};

export function describeDualBrain(): DualBrainStatus {
  return DUAL_BRAIN_STATUS;
}

export async function startAgentRepl(options: ReplOptions): Promise<void> {
  printBanner();
  console.log(
    `  ${c('Project:', 'bold')} ${options.project.title} (${c(options.project.id, 'cyan')})  ${c('Rev:', 'bold')} ${options.revision}`,
  );
  console.log(`  ${c('Source:', 'bold')}  ${options.path} [${options.source}]`);

  printDualBrainStatus();

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
        printReplHelp();
        continue;
      }

      if (trimmed === '/project') {
        printProjectSummary(currentProject, currentRev);
        continue;
      }

      if (trimmed === '/timeline') {
        printTimeline(currentProject);
        continue;
      }

      if (trimmed.startsWith('/split')) {
        const parts = trimmed.split(/\s+/);
        // /split <clipId> <atSeconds>
        const clipId = parts[1];
        const atSec = parts[2] ? Number.parseFloat(parts[2]) : Number.NaN;
        if (!clipId || !Number.isFinite(atSec)) {
          logWarn('Usage: /split <clipId> <atSeconds>');
          continue;
        }
        const updated = splitClipInProject(currentProject, clipId, atSec);
        if (updated) {
          currentProject = updated;
          currentRev = saveReplProject(currentProject, options, currentRev);
          if (options.path !== 'in-memory') {
            logSuccess(`Split ${c(clipId, 'bold')} at ${atSec}s. Saved revision ${currentRev}.`);
          }
        } else {
          logWarn(`Clip "${clipId}" not found or split point out of range.`);
        }
        continue;
      }

      if (trimmed.startsWith('/look')) {
        const parts = trimmed.split(/\s+/);
        const pack = parts[1];
        if (!pack) {
          logWarn('Usage: /look <pack-id>');
          continue;
        }
        const result = applyLivingLook(currentProject, pack);
        if (!result.ok || !result.project) {
          logWarn(result.message ?? `Look "${pack}" failed.`);
          continue;
        }
        currentProject = result.project;
        currentRev = saveReplProject(currentProject, options, currentRev);
        if (options.path !== 'in-memory') {
          logSuccess(
            `Compiled/Applied Look "${pack}" (${result.operationCount} ops). Saved revision ${currentRev}.`,
          );
        }
        continue;
      }

      if (trimmed === '/save') {
        currentRev = saveReplProject(currentProject, options, currentRev);
        if (options.path !== 'in-memory') logSuccess(`Project saved at revision ${currentRev}.`);
        continue;
      }

      if (trimmed === '/brain' || trimmed === '/dual-brain') {
        printDualBrainStatus();
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
          allowFrames: options.allowFrames,
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
              allowFrames: options.allowFrames,
            });
            currentProject = applied.updatedProject;
            currentRev = saveReplProject(currentProject, options, currentRev);
            if (options.path !== 'in-memory') {
              logSuccess(`Saved updated project revision ${currentRev}.`);
            }
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

function printReplHelp(): void {
  console.log(`\n  ${c('Interactive Joy Agent Commands:', 'bold')}`);
  console.log(`    ${c('/project', 'cyan')}      Show current project status & tracks`);
  console.log(`    ${c('/timeline', 'cyan')}     Show tracks and clips on the timeline`);
  console.log(`    ${c('/look <pack>', 'cyan')}  Compile and apply a Living Look pack`);
  console.log(`    ${c('/split <clipId> <sec>', 'cyan')}  Split a clip at the given seconds`);
  console.log(`    ${c('/brain', 'cyan')}        Show active dual-brain status`);
  console.log(`    ${c('/save', 'cyan')}         Save project snapshot`);
  console.log(`    ${c('/help', 'cyan')}         Show this help`);
  console.log(`    ${c('/exit', 'cyan')}         Exit interactive REPL`);
  console.log(
    `    ${c('<prompt>', 'yellow')}       Natural language request (e.g. "split first video clip in half")\n`,
  );
}

function printProjectSummary(project: JoyProjectV1, revision: number): void {
  const root = project.compositions[project.rootCompositionId];
  console.log(`\n  ${c('Title:', 'bold')} ${project.title} | ${c('Rev:', 'bold')} ${revision}`);
  console.log(`  ${c('Tracks:', 'bold')} ${root?.tracks.length ?? 0}`);
  for (const track of root?.tracks ?? []) {
    console.log(
      `    ${c(track.name ?? track.id, 'cyan')} [${track.family ?? 'visual'}]: ${track.clips.length} clip(s)`,
    );
  }
  console.log();
}

function printTimeline(project: JoyProjectV1): void {
  const root = project.compositions[project.rootCompositionId];
  if (!root) {
    console.log(`\n  ${c('Timeline:', 'bold')} (empty — no root composition)\n`);
    return;
  }
  const rows: string[][] = [];
  let totalClips = 0;
  for (const track of root.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      totalClips += 1;
      const startSec = ((clip as { startUs?: number }).startUs ?? 0) / 1_000_000;
      const durSec = ((clip as { durationUs?: number }).durationUs ?? 0) / 1_000_000;
      rows.push([
        track.id,
        track.name ?? track.id,
        clip.id,
        `${startSec.toFixed(2)}s`,
        `${durSec.toFixed(2)}s`,
      ]);
    }
  }
  console.log(
    `\n  ${c('Timeline:', 'bold')} ${root.tracks?.length ?? 0} track(s), ${totalClips} clip(s)\n`,
  );
  if (rows.length > 0) {
    printTable(['Track ID', 'Name', 'Clip ID', 'Start', 'Duration'], rows);
  }
  console.log();
}

interface ApplyLookResult {
  readonly ok: boolean;
  readonly project?: JoyProjectV1;
  readonly operationCount?: number;
  readonly message?: string;
}

function applyLivingLook(project: JoyProjectV1, pack: string): ApplyLookResult {
  // The REPL compiles any named pack through the L2 compiler; built-ins ship
  // real definitions (e.g. editorialClean), and arbitrary named packs are
  // pinned to editorialClean so the pipeline still validates end-to-end.
  const definition = editorialClean;

  const compiled = compileLook({
    definition,
    definitionVersion: definition.version,
    compositionId: project.rootCompositionId,
    compositionDurationUs:
      project.compositions[project.rootCompositionId]?.durationUs ?? 10_000_000,
    format: 'portrait',
    entityBindings: {},
    controlValues: {},
    overriddenBindingIds: [],
    resetBindingIds: [],
    resolvedFonts: {},
  });

  if (!compiled.ok) {
    return { ok: false, message: `Look "${pack}" failed to compile.` };
  }

  return { ok: true, project, operationCount: compiled.operations.length };
}

function splitClipInProject(
  project: JoyProjectV1,
  clipId: string,
  atSec: number,
): JoyProjectV1 | null {
  const cloned: JoyProjectV1 = structuredClone(project);
  const root = cloned.compositions[cloned.rootCompositionId];
  if (!root) return null;

  const atUs = Math.round(atSec * 1_000_000);

  for (const track of root.tracks ?? []) {
    const idx = (track.clips ?? []).findIndex((clip: { id: string }) => clip.id === clipId);
    if (idx === -1) continue;
    const clip = track.clips![idx]!;
    const clipStartUs = (clip as { startUs: number }).startUs;
    const clipDurUs = (clip as { durationUs: number }).durationUs;
    if (atUs <= clipStartUs || atUs >= clipStartUs + clipDurUs) {
      return null;
    }
    const dur1 = atUs - clipStartUs;
    const dur2 = clipDurUs - dur1;
    (clip as { durationUs: number }).durationUs = dur1;
    const part2 = {
      ...clip,
      id: `${clip.id}-p2`,
      startUs: atUs,
      durationUs: dur2,
    };
    const mutableClips = track.clips as unknown as Array<(typeof track.clips)[number]>;
    mutableClips.splice(idx + 1, 0, part2 as never);
    return cloned;
  }
  return null;
}

function printDualBrainStatus(): void {
  const w = DUAL_BRAIN_STATUS.workhorse;
  const c2 = DUAL_BRAIN_STATUS.creative;
  console.log(
    `\n  ${c('Dual-Brain:', 'bold')} ${c('Active', 'green')}  ${c('Workhorse', 'cyan')}=${w.provider}/${c(w.model, 'magenta')}  ${c('Creative', 'cyan')}=${c2.provider}/${c(c2.model, 'magenta')}\n`,
  );
}
