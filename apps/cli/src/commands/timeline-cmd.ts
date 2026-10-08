/* global console */
import type { CliFlags } from '../cli.js';
import { FlagValidationError, NUMERIC_RANGES } from '../utils/flags.js';
import { c, logError, logSuccess, logWarn } from '../utils/logger.js';
import { loadProject, saveProject } from '../utils/project-loader.js';
import { recomputeRootDuration } from '../utils/timeline-math.js';
import { sourceTimeAtVideoClipTime, validateJoyProjectV1 } from '@joy-media/project-schema';
import { createTextClip } from '../render/text-clip.js';
import { resolveTextFont } from '../render/text-font.js';
import { layoutFfmpegCaption } from '../render/caption-layout.js';
import { closestMatch } from '../utils/suggest.js';
import { pickAlias, resolveLookAliases, type JoyLookPreset } from '@joy-media/joy-agent-engine';

export interface TimelineCommandFlags {
  project?: string | undefined;
  track?: string | undefined;
  clip?: string | undefined;
  asset?: string | undefined;
  text?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  direction?: 'rtl' | 'ltr' | 'auto' | undefined;
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

/** Every `joy-media timeline` subcommand: the help line and the unknown-subcommand hint. */
export const TIMELINE_SUBCOMMANDS = [
  'list',
  'add-clip',
  'add-text',
  'add-effect',
  'clear-effect',
  'split',
  'trim',
  'move-clip',
  'remove-clip',
] as const;

export function printTimelineHelp(): void {
  console.log(`Usage: joy-media timeline <${TIMELINE_SUBCOMMANDS.join('|')}> --project <id|file>
  list [--json]
  add-clip --asset <id> [--track <id>] [--start <seconds>] [--duration <seconds>]
  add-text --text <text> [--track <id>] [--start <seconds>] --duration <seconds> [--x <frame-fraction> --y <frame-fraction> --direction <rtl|ltr|auto> --size <template-multiplier> --color <#RRGGBB>]
  split --clip <id> --at <seconds>
  trim --clip <id> [--start <seconds>] [--end <seconds>] [--duration <seconds>]
  move-clip --clip <id> --start <timeline-seconds>
  remove-clip --clip <id>`);
  console.log(
    '  trim --start changes the clip timeline position as well as its source in-point; --start 7 --end 17 leaves it at timeline 7–17s. Use move-clip --start 0 to place it at 0 while keeping the trimmed source range.',
  );
  console.log(
    '  Text placement: x is horizontal frame offset (0 = center, -0.4 = near left, 0.4 = near right).',
  );
  console.log(
    '  y offsets the template bottom title line (0 = default position, negative = up, positive = down); rendering clamps y to the frame, and add-text warns if text may clip.',
  );
  console.log(
    '  add-effect <clipId> --look <crt|bw|warm|cool> (any case; also --type/--kind) [--intensity 0..1] [--scanline-strength 0..1] [--noise-amount 0..1]',
  );
  console.log(
    '  Every --clip also accepts --clipId or --clip-id. Giving two different values (or two different looks) is an error.',
  );
  console.log('  clear-effect <clipId>');
}

export async function handleTimelineCommand(args: string[], flags: CliFlags): Promise<number> {
  validateRange(flags.start, NUMERIC_RANGES.start, 'start');
  validateRange(flags.duration, NUMERIC_RANGES.duration, 'duration');
  validateRange(flags.end, NUMERIC_RANGES.end, 'end');
  validateRange(flags.at, NUMERIC_RANGES.at, 'at');
  const sub = args[0];

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printTimelineHelp();
    return 0;
  }
  if (!(TIMELINE_SUBCOMMANDS as readonly string[]).includes(sub ?? '')) {
    const guess = sub === undefined ? undefined : closestMatch(sub, TIMELINE_SUBCOMMANDS);
    logError(
      sub === undefined
        ? 'Missing timeline subcommand.'
        : `Unknown timeline subcommand "${sub}".${guess ? ` Did you mean "${guess}"?` : ''}`,
    );
    console.log(`Available: ${TIMELINE_SUBCOMMANDS.join(', ')}`);
    return 2;
  }

  // The clip id and look aliases follow the same rules as the agent's operation schema:
  // any case for looks, and two aliases that disagree are an error, never a silent pick.
  let clipFlag: string | undefined;
  let look: JoyLookPreset | undefined;
  try {
    const clipAliases = [
      ['--clip', flags.clip],
      ['--clipId', flags.clipId],
      ['--clip-id', flags.clipIdDash],
    ] as const;
    clipFlag = pickAlias('clip id', clipAliases) as string | undefined;
    if (sub === 'add-effect' || sub === 'clear-effect')
      clipFlag = pickAlias('clip id', [['<clipId>', args[1]], ...clipAliases]) as
        string | undefined;
    if (sub === 'add-effect')
      look = resolveLookAliases([
        ['--look', flags.look],
        ['--kind', flags.kind],
        ['--type', flags.type],
      ]);
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    return 2;
  }

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

  if (sub === 'list') {
    const tracks = root.tracks.map((track) => ({
      id: track.id,
      kind: track.family === 'audio' ? 'audio' : track.kind,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        kind: clip.kind,
        timelineStartUs: clip.startUs,
        timelineEndUs: clip.startUs + clip.durationUs,
        ...(clip.kind === 'video'
          ? {
              sourceInUs: clip.sourceInUs,
              sourceOutUs: clip.sourceInUs + Math.round(clip.durationUs * (clip.playbackRate ?? 1)),
            }
          : {}),
        ...('look' in clip && clip.look ? { look: clip.look } : {}),
        ...('effects' in clip && Array.isArray(clip.effects) ? { effects: clip.effects } : {}),
      })),
    }));
    if (flags.json) {
      console.log(JSON.stringify({ projectId: project.id, tracks }, null, 2));
      return 0;
    }
    console.log(`Timeline: ${project.title} (${project.id})`);
    for (const track of tracks) {
      console.log(`${track.id} [${track.kind}]`);
      for (const clip of track.clips) {
        console.log(
          `  ${clip.id} [${clip.kind}] timeline=${(clip.timelineStartUs / 1_000_000).toFixed(3)}–${(clip.timelineEndUs / 1_000_000).toFixed(3)}s${clip.sourceInUs === undefined ? '' : ` source=${(clip.sourceInUs / 1_000_000).toFixed(3)}–${(clip.sourceOutUs! / 1_000_000).toFixed(3)}s`}${clip.look ? ` look=${typeof clip.look === 'string' ? clip.look : ((clip.look as { preset?: string }).preset ?? 'custom')}` : ''}${clip.effects ? ` effects=${JSON.stringify(clip.effects)}` : ''}`,
        );
      }
    }
    return 0;
  }

  if (sub === 'add-effect' || sub === 'clear-effect') {
    const clipId = clipFlag;
    if (!clipId) {
      logError(
        `Usage: joy-media timeline ${sub} <clipId> --project <id|file>${sub === 'add-effect' ? ' --look <crt|bw|warm|cool>' : ''}`,
      );
      return 1;
    }
    if (sub === 'add-effect' && look === undefined) {
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
        preset: look!,
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
      `${sub === 'add-effect' ? `Applied ${look} look to` : 'Cleared look from'} ${c(clipId, 'bold')} (saved rev ${nextRev}).`,
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
        ...(flags.direction === undefined ? {} : { direction: flags.direction }),
      });
    } catch (error) {
      logError(`unsupported: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    (project.captionDocuments as Record<string, unknown>)[created.document.id] = created.document;
    const rootWidth = root.width ?? 1920;
    const rootHeight = root.height ?? 1080;
    const segment = created.document.segments[0]!;
    const layout = layoutFfmpegCaption({
      clipId: created.clip.id,
      document: created.document,
      segment,
      style: created.clip.style!,
      width: rootWidth,
      height: rootHeight,
    });
    const baseline = layoutFfmpegCaption({
      clipId: created.clip.id,
      document: created.document,
      segment,
      style: { ...created.clip.style!, positionX: 0, positionY: 0 },
      width: rootWidth,
      height: rootHeight,
    });
    const clipped =
      layout.length < baseline.length ||
      layout.some((line) => {
        const estimatedWidth = Math.min(
          line.maxWidth ?? rootWidth,
          line.text.length * (line.fontSizePx ?? 16) * 0.62,
        );
        const left =
          line.align === 'right'
            ? line.transform.translateX - estimatedWidth
            : line.align === 'center'
              ? line.transform.translateX - estimatedWidth / 2
              : line.transform.translateX;
        const top = line.transform.translateY;
        return (
          left < 0 ||
          left + estimatedWidth > rootWidth ||
          top < 0 ||
          top + (line.fontSizePx ?? 16) > rootHeight
        );
      });
    if (clipped) {
      if (flags.strict) {
        logError('Text would be clipped at this position; no changes were saved.');
        return 1;
      }
      logWarn('Text may be clipped at this position.');
    }
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
    const selectedAssetId = flags.asset ?? args[1];
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
    if (!clipFlag || flags.at === undefined) {
      logError('Usage: joy-media timeline split --project <id> --clip <clipId> --at <seconds>');
      return 1;
    }

    const atUs = Math.round(flags.at * 1_000_000);
    let found = false;

    for (const track of tracks) {
      const idx = track.clips.findIndex((c) => c.id === clipFlag);
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
      logError(`Clip "${clipFlag}" not found.`);
      return 1;
    }

    recomputeRootDuration(project);

    const nextRev = saveProject(project, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });

    logSuccess(`Split clip ${c(clipFlag, 'bold')} at ${flags.at}s (saved rev ${nextRev}).`);
    return 0;
  }

  if (sub === 'trim') {
    if (!clipFlag) {
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

    const { num: fpsNum, den: fpsDen } = root.frameRate;
    const minimumFrameUs = Math.ceil((1_000_000 * fpsDen) / fpsNum);
    const fpsLabel =
      fpsDen === 1 ? String(fpsNum) : (fpsNum / fpsDen).toFixed(3).replace(/\.?0+$/, '');
    let found = false;
    for (const track of tracks) {
      const clip = track.clips.find((c) => c.id === clipFlag);
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
        const mediaEnd = videoMediaEndUs(project, clip);
        if (mediaEnd !== undefined && clip.kind === 'video') {
          const rate =
            typeof clip.playbackRate === 'number' && clip.playbackRate > 0 ? clip.playbackRate : 1;
          const sourceInUs = clip.sourceInUs ?? 0;
          if (sourceInUs >= mediaEnd) {
            logError(
              `Trim start puts clip "${clipFlag}" at source ${formatSeconds(sourceInUs)}, beyond the end of its media (${formatSeconds(mediaEnd)}). Nothing was changed.`,
            );
            return 1;
          }
          if (sourceInUs + Math.round(clip.durationUs * rate) > mediaEnd) {
            clip.durationUs = Math.floor((mediaEnd - sourceInUs) / rate);
            // Clamping must never leave less than one frame: reject instead (N3).
            if (clip.durationUs < minimumFrameUs) {
              logError(
                `Trim leaves clip "${clipFlag}" ${formatSeconds(clip.durationUs)} long (source ${formatSeconds(sourceInUs)} to the media end at ${formatSeconds(mediaEnd)}), shorter than one frame at ${fpsLabel} fps (${formatSeconds(minimumFrameUs)}). Nothing was changed.`,
              );
              return 1;
            }
            logWarn(
              `Clip "${clipFlag}" ends at source ${formatSeconds(mediaEnd)}: clamped to the media end (${formatSeconds(mediaEnd)}).`,
            );
          }
        }
        if (clip.durationUs < minimumFrameUs) {
          logError(
            `Trim leaves clip "${clipFlag}" ${formatSeconds(clip.durationUs)} long, shorter than one frame at ${fpsLabel} fps (${formatSeconds(minimumFrameUs)}). Nothing was changed.`,
          );
          return 1;
        }
        found = true;
        track.clips.sort((a, b) => a.startUs - b.startUs);
        break;
      }
    }

    if (!found) {
      logError(`Clip "${clipFlag}" not found.`);
      return 1;
    }

    recomputeRootDuration(project);

    const nextRev = saveProject(project, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });

    logSuccess(`Trimmed clip ${c(clipFlag, 'bold')} (saved rev ${nextRev}).`);
    return 0;
  }

  if (sub === 'move-clip') {
    if (!clipFlag || flags.start === undefined) {
      logError(
        'Usage: joy-media timeline move-clip --project <id> --clip <clipId> --start <seconds>',
      );
      return 1;
    }
    const clip = tracks.flatMap((track) => track.clips).find((item) => item.id === clipFlag);
    if (!clip) {
      logError(`Clip "${clipFlag}" not found.`);
      return 1;
    }
    clip.startUs = Math.round(flags.start * 1_000_000);
    for (const track of tracks) track.clips.sort((a, b) => a.startUs - b.startUs);
    recomputeRootDuration(project);
    const nextRev = saveProject(project, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });
    logSuccess(`Moved clip ${c(clipFlag, 'bold')} to ${flags.start}s (saved rev ${nextRev}).`);
    return 0;
  }

  if (sub === 'remove-clip') {
    if (!clipFlag) {
      logError('Usage: joy-media timeline remove-clip --project <id> --clip <clipId>');
      return 1;
    }

    let found = false;
    for (const track of tracks) {
      const idx = track.clips.findIndex((c) => c.id === clipFlag);
      if (idx !== -1) {
        track.clips.splice(idx, 1);
        found = true;
        break;
      }
    }

    if (!found) {
      logError(`Clip "${clipFlag}" not found.`);
      return 1;
    }

    recomputeRootDuration(project);

    const nextRev = saveProject(project, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });

    logSuccess(`Removed clip ${c(clipFlag, 'bold')} (saved rev ${nextRev}).`);
    return 0;
  }

  logError(`Unknown timeline subcommand: ${sub}`);
  return 2;
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

/** Source media length for a forward, unremapped video clip, when the asset records it. */
function videoMediaEndUs(
  project: {
    readonly assets?: Record<string, { readonly descriptor?: { readonly durationUs?: number } }>;
  },
  clip: {
    readonly kind?: string;
    readonly assetId?: string;
    readonly timeRemap?: unknown;
    readonly reversed?: boolean;
  },
): number | undefined {
  if (clip.kind !== 'video' || clip.timeRemap !== undefined || clip.reversed === true)
    return undefined;
  const duration = clip.assetId
    ? project.assets?.[clip.assetId]?.descriptor?.durationUs
    : undefined;
  return typeof duration === 'number' && duration > 0 ? duration : undefined;
}

function formatSeconds(microseconds: number): string {
  return `${(microseconds / 1_000_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}s`;
}
