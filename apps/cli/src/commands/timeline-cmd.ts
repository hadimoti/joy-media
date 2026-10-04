/* global console */
import type { CliFlags } from '../cli.js';
import { FlagValidationError, NUMERIC_RANGES } from '../utils/flags.js';
import { c, logError, logSuccess } from '../utils/logger.js';
import { loadProject, saveProject } from '../utils/project-loader.js';
import { recomputeRootDuration } from '../utils/timeline-math.js';
import { sourceTimeAtVideoClipTime } from '@joy-media/project-schema';

export interface TimelineCommandFlags {
  project?: string | undefined;
  track?: string | undefined;
  clip?: string | undefined;
  asset?: string | undefined;
  start?: number | undefined;
  duration?: number | undefined;
  end?: number | undefined;
  at?: number | undefined;
  sqlitePath?: string | undefined;
}

export function printTimelineHelp(): void {
  console.log(`Usage: joy-media timeline <add-clip|split|trim|remove-clip> --project <id|file>
  add-clip --asset <id> [--track <id>] [--start <seconds>] [--duration <seconds>]
  split --clip <id> --at <seconds>
  trim --clip <id> [--start <seconds>] [--end <seconds>] [--duration <seconds>]
  remove-clip --clip <id>`);
}

export async function handleTimelineCommand(args: string[], flags: CliFlags): Promise<number> {
  validateRange(flags.start, NUMERIC_RANGES.start, 'start');
  validateRange(flags.duration, NUMERIC_RANGES.duration, 'duration');
  validateRange(flags.end, NUMERIC_RANGES.end, 'end');
  validateRange(flags.at, NUMERIC_RANGES.at, 'at');
  const sub = args[0];

  if (!flags.project) {
    logError('Please specify target project via --project <id|file.json>');
    return 1;
  }

  let projectInfo;
  try {
    projectInfo = loadProject(flags.project, flags.sqlitePath);
  } catch (err) {
    logError(`Cannot load project: ${String(err)}`);
    return 1;
  }

  const project = structuredClone(projectInfo.project);
  const root = project.compositions[project.rootCompositionId];
  if (!root) {
    logError('Project has no root composition.');
    return 1;
  }

  const tracks = root.tracks as unknown as Array<{
    id: string;
    name?: string;
    clips: Array<{
      id: string;
      startUs: number;
      durationUs: number;
      kind?: string;
      sourceInUs?: number;
      childOffsetUs?: number;
      playbackRate?: number;
      reversed?: boolean;
      [key: string]: unknown;
    }>;
  }>;

  if (sub === 'add-clip') {
    const trackId = flags.track ?? tracks[0]?.id;
    if (!trackId) {
      logError('No tracks available in project.');
      return 1;
    }
    const track = tracks.find((t) => t.id === trackId);
    if (!track) {
      logError(`Track "${trackId}" not found.`);
      return 1;
    }

    const startUs = Math.round((flags.start ?? 0) * 1_000_000);
    const durationUs = Math.round((flags.duration ?? 3) * 1_000_000);
    const clipId = `clip-${Date.now().toString(36)}`;
    const assetId = flags.asset ?? 'asset-default';

    track.clips.push({
      id: clipId,
      kind: 'video',
      assetId,
      startUs,
      durationUs,
      sourceInUs: 0,
    });
    track.clips.sort((a, b) => a.startUs - b.startUs);
    recomputeRootDuration(project);

    const nextRev = saveProject(project, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });

    logSuccess(
      `Added clip ${c(clipId, 'bold')} to track ${c(track.name ?? track.id, 'cyan')} (saved rev ${nextRev}).`,
    );
    return 0;
  }

  if (sub === 'split') {
    if (!flags.clip || flags.at === undefined) {
      logError('Usage: joy-media timeline split --project <id> --clip <clipId> --at <seconds>');
      return 1;
    }

    const atUs = Math.round(flags.at * 1_000_000);
    let found = false;

    for (const track of tracks) {
      const idx = track.clips.findIndex((c) => c.id === flags.clip);
      if (idx !== -1) {
        const clip = track.clips[idx]!;
        if (atUs <= clip.startUs || atUs >= clip.startUs + clip.durationUs) {
          logError(
            `Split point ${flags.at}s is outside clip range [${clip.startUs / 1_000_000}s, ${(clip.startUs + clip.durationUs) / 1_000_000}s]`,
          );
          return 1;
        }

        const originalDuration = clip.durationUs;
        const dur1 = atUs - clip.startUs;
        const dur2 = originalDuration - dur1;

        let secondSourceInUs: number | undefined;
        if (clip.kind === 'video') {
          secondSourceInUs = sourceTimeAtVideoClipTime(clip as never, atUs);
          if (secondSourceInUs < 0) {
            logError('Split would use a negative source time.');
            return 1;
          }
        }

        clip.durationUs = dur1;
        const part2 = {
          ...clip,
          id: `${clip.id}-p2`,
          startUs: atUs,
          durationUs: dur2,
        } as typeof clip;
        if (clip.kind === 'video') {
          part2.sourceInUs = secondSourceInUs!;
        } else if (clip.kind === 'composition') {
          part2.childOffsetUs = (part2.childOffsetUs ?? 0) + dur1;
        }

        track.clips.splice(idx + 1, 0, part2);
        track.clips.sort((a, b) => a.startUs - b.startUs);
        found = true;
        break;
      }
    }

    if (!found) {
      logError(`Clip "${flags.clip}" not found.`);
      return 1;
    }

    recomputeRootDuration(project);

    const nextRev = saveProject(project, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });

    logSuccess(`Split clip ${c(flags.clip, 'bold')} at ${flags.at}s (saved rev ${nextRev}).`);
    return 0;
  }

  if (sub === 'trim') {
    if (!flags.clip) {
      logError(
        'Usage: joy-media timeline trim --project <id> --clip <clipId> [--start <sec>] [--end <sec>]',
      );
      return 1;
    }

    if (flags.start !== undefined && flags.end !== undefined && flags.end <= flags.start) {
      logError(
        `Invalid trim range: --end (${flags.end}s) must be greater than --start (${flags.start}s).`,
      );
      return 1;
    }

    let found = false;
    for (const track of tracks) {
      const clip = track.clips.find((c) => c.id === flags.clip);
      if (clip) {
        if (flags.start !== undefined) {
          const nextStartUs = Math.round(flags.start * 1_000_000);
          const oldStartUs = clip.startUs;
          if (clip.kind === 'video') {
            const sourceInUs = sourceTimeAtVideoClipTime(clip as never, nextStartUs);
            if (sourceInUs < 0) {
              logError('Trim would use a negative source time.');
              return 1;
            }
            clip.sourceInUs = sourceInUs;
          } else if (clip.kind === 'composition') {
            clip.childOffsetUs = (clip.childOffsetUs ?? 0) + nextStartUs - oldStartUs;
          }
          clip.startUs = nextStartUs;
        }
        if (flags.end !== undefined) {
          const endUs = Math.round(flags.end * 1_000_000);
          clip.durationUs = Math.max(1000, endUs - clip.startUs);
        } else if (flags.duration !== undefined) {
          clip.durationUs = Math.round(flags.duration * 1_000_000);
        }
        found = true;
        track.clips.sort((a, b) => a.startUs - b.startUs);
        break;
      }
    }

    if (!found) {
      logError(`Clip "${flags.clip}" not found.`);
      return 1;
    }

    recomputeRootDuration(project);

    const nextRev = saveProject(project, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });

    logSuccess(`Trimmed clip ${c(flags.clip, 'bold')} (saved rev ${nextRev}).`);
    return 0;
  }

  if (sub === 'remove-clip') {
    if (!flags.clip) {
      logError('Usage: joy-media timeline remove-clip --project <id> --clip <clipId>');
      return 1;
    }

    let found = false;
    for (const track of tracks) {
      const idx = track.clips.findIndex((c) => c.id === flags.clip);
      if (idx !== -1) {
        track.clips.splice(idx, 1);
        found = true;
        break;
      }
    }

    if (!found) {
      logError(`Clip "${flags.clip}" not found.`);
      return 1;
    }

    recomputeRootDuration(project);

    const nextRev = saveProject(project, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });

    logSuccess(`Removed clip ${c(flags.clip, 'bold')} (saved rev ${nextRev}).`);
    return 0;
  }

  logError(`Unknown timeline subcommand: ${sub}`);
  console.log(
    `Available: ${c('add-clip', 'cyan')}, ${c('split', 'cyan')}, ${c('trim', 'cyan')}, ${c('remove-clip', 'cyan')}`,
  );
  return 1;
}

function validateRange(
  value: number | undefined,
  range: { min: number; max: number },
  flag: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value)) {
    throw new FlagValidationError(flag, 'value is not a finite number', value);
  }
  if (value < range.min) {
    throw new FlagValidationError(flag, `value must be >= ${range.min}`, value);
  }
  if (value > range.max) {
    throw new FlagValidationError(flag, `value must be <= ${range.max}`, value);
  }
}
