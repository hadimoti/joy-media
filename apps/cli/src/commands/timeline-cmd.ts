/* global console */
import type { CliFlags } from '../cli.js';
import { FlagValidationError, NUMERIC_RANGES } from '../utils/flags.js';
import { c, logError, logSuccess } from '../utils/logger.js';
import { loadProject, saveProject } from '../utils/project-loader.js';
import { recomputeRootDuration } from '../utils/timeline-math.js';
import { sourceTimeAtVideoClipTime, validateJoyProjectV1 } from '@joy-media/project-schema';
import { createTextClip } from '../render/text-clip.js';
import { resolveTextFont } from '../render/text-font.js';

export interface TimelineCommandFlags {
  project?: string | undefined;
  track?: string | undefined;
  clip?: string | undefined;
  asset?: string | undefined;
  text?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  size?: number | undefined;
  color?: string | undefined;
  start?: number | undefined;
  duration?: number | undefined;
  end?: number | undefined;
  at?: number | undefined;
  sqlitePath?: string | undefined;
  look?: string | undefined;
  intensity?: number | undefined;
  scanlineStrength?: number | undefined;
  noiseAmount?: number | undefined;
}

export function printTimelineHelp(): void {
  console.log(`Usage: joy-media timeline <add-clip|add-text|add-effect|clear-effect|split|trim|remove-clip> --project <id|file>
  add-clip --asset <id> [--track <id>] [--start <seconds>] [--duration <seconds>]
  add-text --text <text> [--track <id>] [--start <seconds>] --duration <seconds> [--x <frame-fraction> --y <frame-fraction> --size <template-multiplier> --color <#RRGGBB>]
  split --clip <id> --at <seconds>
  trim --clip <id> [--start <seconds>] [--end <seconds>] [--duration <seconds>]
  remove-clip --clip <id>`);
  console.log(
    '  add-effect <clipId> --look <crt|bw|warm|cool> [--intensity 0..1] [--scanline-strength 0..1] [--noise-amount 0..1]',
  );
  console.log('  clear-effect <clipId>');
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

  if (sub === 'add-effect' || sub === 'clear-effect') {
    const clipId = args[1] ?? flags.clip;
    if (!clipId) {
      logError(
        `Usage: joy-media timeline ${sub} <clipId> --project <id|file>${sub === 'add-effect' ? ' --look <crt|bw|warm|cool>' : ''}`,
      );
      return 1;
    }
    if (sub === 'add-effect' && !['crt', 'bw', 'warm', 'cool'].includes(flags.look ?? '')) {
      logError('Look must be one of: crt, bw, warm, cool.');
      return 1;
    }
    const clip = (root.tracks as unknown as Array<{ clips: Array<Record<string, unknown>> }>)
      .flatMap((track) => track.clips)
      .find((item) => item.id === clipId);
    if (!clip) {
      logError(`Clip "${clipId}" not found.`);
      return 1;
    }
    if (clip.kind !== 'video') {
      logError('Clip looks can only be applied to video clips.');
      return 1;
    }
    if (sub === 'clear-effect') delete clip.look;
    else {
      clip.look = {
        preset: flags.look as 'crt' | 'bw' | 'warm' | 'cool',
        ...(flags.intensity === undefined ? {} : { intensity: flags.intensity }),
        ...(flags.scanlineStrength === undefined
          ? {}
          : { scanlineStrength: flags.scanlineStrength }),
        ...(flags.noiseAmount === undefined ? {} : { noiseAmount: flags.noiseAmount }),
      };
    }
    const diagnostics = validateJoyProjectV1(project);
    if (diagnostics.length) {
      logError(`Invalid clip look: ${diagnostics[0]!.message}`);
      return 1;
    }
    const nextRev = saveProject(project, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });
    logSuccess(
      `${sub === 'add-effect' ? `Applied ${flags.look} look to` : 'Cleared look from'} ${c(clipId, 'bold')} (saved rev ${nextRev}).`,
    );
    return 0;
  }

  const tracks = root.tracks as unknown as Array<{
    id: string;
    name?: string;
    kind?: string;
    family?: string;
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

  if (sub === 'add-text') {
    if (!flags.text || flags.duration === undefined) {
      logError(
        'Usage: joy-media timeline add-text --project <id|file> --text <text> --duration <seconds> [--start <seconds>]',
      );
      return 1;
    }
    if (!resolveTextFont()) {
      logError('unsupported: no usable font found; set JOY_FONT or install DejaVu Sans.');
      return 1;
    }
    let track = flags.track
      ? tracks.find((candidate) => candidate.id === flags.track)
      : tracks.find((candidate) => candidate.kind === 'caption');
    if (track && track.kind !== 'caption') {
      logError(`unsupported: text needs a caption track (${track.id}).`);
      return 1;
    }
    if (!track) {
      if (flags.track) {
        logError(`unsupported: caption track ${flags.track} was not found.`);
        return 1;
      }
      const captionTrack = {
        id: `track-captions-${tracks.length + 1}`,
        kind: 'caption',
        family: 'visual',
        name: 'Captions',
        order:
          Math.max(
            -1,
            ...tracks.map((candidate) => Number((candidate as { order?: number }).order ?? -1)),
          ) + 1,
        enabled: true,
        locked: false,
        clips: [],
      };
      tracks.push(captionTrack);
      track = captionTrack;
    }
    const id = `text-${Date.now().toString(36)}`;
    let created;
    try {
      created = createTextClip({
        id,
        text: flags.text,
        startUs: Math.round((flags.start ?? 0) * 1_000_000),
        durationUs: Math.round(flags.duration * 1_000_000),
        ...(flags.x === undefined ? {} : { x: flags.x }),
        ...(flags.y === undefined ? {} : { y: flags.y }),
        ...(flags.size === undefined ? {} : { size: flags.size }),
        ...(flags.color === undefined ? {} : { color: flags.color }),
      });
    } catch (error) {
      logError(`unsupported: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    (project.captionDocuments as Record<string, unknown>)[created.document.id] = created.document;
    track.clips.push(created.clip as unknown as (typeof track.clips)[number]);
    recomputeRootDuration(project);
    const diagnostics = validateJoyProjectV1(project);
    if (diagnostics.length > 0) {
      logError(`unsupported: text clip is not schema-valid (${diagnostics[0]!.message}).`);
      return 1;
    }
    const nextRev = saveProject(project, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });
    logSuccess(
      `Added renderable text clip ${c(created.clip.id, 'bold')} to ${track.name ?? track.id} (saved rev ${nextRev}).`,
    );
    return 0;
  }

  if (sub === 'add-clip') {
    const selectedAssetId = flags.asset;
    const selectedAsset = selectedAssetId ? project.assets[selectedAssetId] : undefined;
    if (selectedAssetId && !selectedAsset) {
      logError(`Asset "${selectedAssetId}" not found in project.`);
      return 1;
    }
    if (selectedAssetId && flags.duration === undefined && !selectedAsset?.descriptor?.durationUs) {
      logError(`Asset "${selectedAssetId}" has no duration; specify --duration.`);
      return 1;
    }
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
    const durationUs =
      flags.duration !== undefined
        ? Math.round(flags.duration * 1_000_000)
        : (selectedAsset?.descriptor?.durationUs ?? 3_000_000);
    const clipId = `clip-${Date.now().toString(36)}`;
    const assetId = selectedAssetId ?? 'asset-default';

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
