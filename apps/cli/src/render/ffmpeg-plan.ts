import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FfmpegTextFile } from './text-files.js';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { escapeFilterPath, resolveTextFont } from './text-font.js';
import {
  ffmpegCaptionFontSize,
  ffmpegCaptionX,
  ffmpegCaptionY,
  layoutFfmpegCaption,
} from './caption-layout.js';
import { missingFontCodePoints } from './font-cmap.js';
import { probeFfmpegTextCapabilities, type FfmpegTextCapabilities } from './text-capabilities.js';
import { containsRtlOrComplexScript } from './text-scripts.js';
import { resolveCaptionDirection } from '@joy-media/captions-core';
import { wrapDrawtextDirection } from './text-clip.js';

export interface FfmpegRenderOverrides {
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly font?: string;
  readonly textCapabilities?: FfmpegTextCapabilities;
}

export interface FfmpegRenderPlan {
  readonly args: string[];
  readonly inputs: { readonly assetId: string; readonly path: string }[];
  readonly skipped: { readonly clipId: string; readonly reason: string }[];
  readonly width: number;
  readonly height: number;
  readonly fpsExpr: string;
  readonly durationUs: number;
  readonly textFiles: readonly FfmpegTextFile[];
}

export interface FfmpegFramePlan {
  readonly args: string[];
  readonly inputs: { readonly assetId: string; readonly path: string }[];
  readonly width: number;
  readonly height: number;
  readonly textFiles: readonly FfmpegTextFile[];
}

/** Build a one-frame extraction from the same composited video graph as renders. */
export function buildFfmpegFramePlan(
  project: JoyProjectV1,
  atUs: number,
  maxEdge = 1024,
  textFileDirectory?: string,
): FfmpegFramePlan {
  const render = buildFfmpegRenderPlan(project, 'mp4', {}, textFileDirectory);
  if (!Number.isSafeInteger(atUs) || atUs < 0 || atUs >= render.durationUs)
    throw new RangeError('Frame time must be inside the project duration.');
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 1024)
    throw new RangeError('Frame edge must be an integer from 1 through 1024.');
  const filterIndex = render.args.indexOf('-filter_complex');
  const filterGraph = render.args[filterIndex + 1];
  const mapIndex = render.args.indexOf('-map', filterIndex + 2);
  const videoMap = render.args[mapIndex + 1];
  if (filterIndex < 0 || filterGraph === undefined || mapIndex < 0 || videoMap === undefined)
    throw new Error('Render plan is missing its video graph.');
  const videoFilters = splitFilterGraph(filterGraph).filter(
    (filter) => !/\[\d+:a\]|\[a_\d+\]|\[aout\]|\bamix=|\banullsrc/.test(filter),
  );
  const scaleFilter = `scale=${maxEdge}:${maxEdge}:force_original_aspect_ratio=decrease`;
  const hasVideoFilterGraph = videoFilters.length > 0;
  if (hasVideoFilterGraph) videoFilters.push(`${videoMap}${scaleFilter}[frame]`);
  const frameDimensions = fitWithinMaxEdge(render.width, render.height, maxEdge);
  const args = [
    ...render.args.slice(0, filterIndex),
    ...(hasVideoFilterGraph ? ['-filter_complex', videoFilters.join(';')] : []),
    '-map',
    hasVideoFilterGraph ? '[frame]' : videoMap,
    '-ss',
    seconds(atUs),
    '-frames:v',
    '1',
    ...(!hasVideoFilterGraph ? ['-vf', scaleFilter] : []),
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    'pipe:1',
  ];
  return { args, inputs: render.inputs, textFiles: render.textFiles, ...frameDimensions };
}

function splitFilterGraph(graph: string): string[] {
  const filters: string[] = [];
  let current = '';
  for (let index = 0; index < graph.length; index += 1) {
    const character = graph[index]!;
    if (character === '\\' && index + 1 < graph.length) {
      current += character + graph[index + 1]!;
      index += 1;
    } else if (character === ';') {
      filters.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current.length > 0) filters.push(current);
  return filters;
}

export function buildFfmpegRenderPlan(
  project: JoyProjectV1,
  presetId: 'mp4' | 'webm' | 'prores',
  overrides: FfmpegRenderOverrides = {},
  textFileDirectory?: string,
): FfmpegRenderPlan {
  const root = project.compositions[project.rootCompositionId];
  if (!root) throw new Error('Project has no root composition.');
  const width = positiveOverride(overrides.width, root.width, 'width', 15_360);
  const height = positiveOverride(overrides.height, root.height, 'height', 8_640);
  const fpsNum = overrides.fps ?? root.frameRate.num;
  const fpsDen = overrides.fps === undefined ? root.frameRate.den : 1;
  const fpsValue = fpsNum / fpsDen;
  if (
    !Number.isSafeInteger(fpsNum) ||
    !Number.isSafeInteger(fpsDen) ||
    fpsDen <= 0 ||
    !Number.isFinite(fpsValue) ||
    fpsValue < 1 ||
    fpsValue > 240
  ) {
    throw new RangeError('Render fps must resolve to a rational value from 1 through 240.');
  }
  const fpsExpr = `${fpsNum}/${fpsDen}`;
  const durationUs = root.durationUs;
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0)
    throw new Error('Project duration must be positive.');
  const duration = seconds(durationUs);
  const background = safeColor(root.background);
  const args = [
    '-hide_banner',
    '-f',
    'lavfi',
    '-i',
    `color=c=${background}:s=${width}x${height}:r=${fpsExpr}:d=${duration}`,
  ];
  const inputs: { assetId: string; path: string }[] = [];
  const skipped: { clipId: string; reason: string }[] = [];
  const filters: string[] = ['[0:v]null[vout]'];
  for (const transition of project.transitions ?? []) {
    skipped.push({
      clipId: transition.id,
      reason: 'transitions are not supported by the v1 renderer',
    });
  }
  for (const objectId of Object.keys(project.visualObjects)) {
    skipped.push({
      clipId: objectId,
      reason: 'visual objects are not supported by the v1 renderer',
    });
  }
  if (project.colorGrade) {
    skipped.push({
      clipId: 'master-color-grade',
      reason: 'color grades are not supported by the v1 renderer',
    });
  }
  for (const clipId of Object.keys(project.clipColorGrades ?? {})) {
    skipped.push({ clipId, reason: 'clip color grades are not supported by the v1 renderer' });
  }
  for (const effect of project.audio?.effects ?? []) {
    skipped.push({
      clipId: effect.id,
      reason: 'audio effects are not supported by the v1 renderer',
    });
  }
  for (const audioClipId of Object.keys(project.audio?.clips ?? {})) {
    skipped.push({
      clipId: audioClipId,
      reason: 'project audio graph clips are not supported by the v1 renderer',
    });
  }
  let videoLabel = 'vout';
  let overlayIndex = 0;
  const tracks = [...root.tracks]
    .filter(
      (track) =>
        track.enabled !== false &&
        track.family !== 'audio' &&
        (track.kind === 'video' || track.kind === 'caption'),
    )
    .sort((a, b) => a.order - b.order);
  const audioInputs: string[] = [];
  const textFiles: FfmpegTextFile[] = [];
  const fontBuffers = new Map<string, Uint8Array>();
  let textCapabilities: FfmpegTextCapabilities | undefined = overrides.textCapabilities;
  for (const track of tracks) {
    for (const clip of [...track.clips].sort((a, b) => a.startUs - b.startUs)) {
      if (clip.kind === 'caption') {
        const document = project.captionDocuments?.[clip.captionDocumentId];
        if (!document) {
          skipped.push({
            clipId: clip.id,
            reason: 'unsupported: caption document is missing',
          });
          continue;
        }
        const style = clip.style;
        for (const segment of document.segments) {
          const text =
            segment.textOverride ??
            segment.wordIds.map((wordId) => document.words[wordId]?.text ?? '').join('');
          if (!text) {
            skipped.push({ clipId: clip.id, reason: 'unsupported: caption segment has no text' });
            continue;
          }
          const start = clip.startUs + segment.startUs;
          const end = Math.min(clip.startUs + clip.durationUs, clip.startUs + segment.endUs);
          if (!textFileDirectory) {
            skipped.push({ clipId: clip.id, reason: 'text rendering needs a temporary workspace' });
            continue;
          }
          for (const coordinate of [style?.positionX, style?.positionY]) {
            if (coordinate !== undefined && !Number.isFinite(coordinate))
              throw new RangeError('Caption position must be a finite number.');
          }
          const fontMultiplier = style?.fontSize ?? 1;
          const scale = style?.scale ?? 1;
          if (
            !Number.isFinite(fontMultiplier) ||
            !Number.isFinite(scale) ||
            fontMultiplier <= 0 ||
            scale <= 0
          )
            throw new RangeError('Caption font size and scale must be finite positive numbers.');
          if (
            Math.abs(style?.positionX ?? 0) > 2 ||
            Math.abs(style?.positionY ?? 0) > 2 ||
            (style?.fontSize ?? 1) > 8
          ) {
            skipped.push({
              clipId: clip.id,
              reason:
                'legacy CLI pixel-unit caption style detected; recreate this text with timeline add-text editor units (--x/--y frame fractions and --size template multiplier)',
            });
            continue;
          }
          const fontPath = resolveTextFont(text, overrides.font);
          if (!fontPath) {
            skipped.push({
              clipId: clip.id,
              reason: 'unsupported: no usable font found; set JOY_FONT or install DejaVu Sans',
            });
            continue;
          }
          const fontBuffer = fontBuffers.get(fontPath) ?? readFileSync(fontPath);
          fontBuffers.set(fontPath, fontBuffer);
          let missing: readonly number[];
          try {
            missing = missingFontCodePoints(fontBuffer, text);
          } catch (error) {
            skipped.push({
              clipId: clip.id,
              reason: `font coverage could not be verified for clip ${clip.id} using ${fontPath}: ${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
          }
          if (missing.length > 0) {
            skipped.push({
              clipId: clip.id,
              reason: `font ${fontPath} is missing glyphs for clip ${clip.id}: ${missing.map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')}`,
            });
            continue;
          }
          textCapabilities ??= probeFfmpegTextCapabilities();
          const requiresShaping = containsRtlOrComplexScript(text);
          if (requiresShaping && !textCapabilities.textShaping) {
            skipped.push({
              clipId: clip.id,
              reason:
                'this ffmpeg lacks libfribidi/libharfbuzz; Persian/RTL text would render in the wrong order — install an ffmpeg build with fribidi+harfbuzz or set JOY_FFMPEG',
            });
            continue;
          }
          const layout = layoutFfmpegCaption({
            clipId: clip.id,
            document,
            segment,
            style,
            width,
            height,
          });
          if (layout.length === 0) {
            skipped.push({
              clipId: clip.id,
              reason: 'caption layout produced no visible text line',
            });
            continue;
          }
          const color = drawtextColor(style?.textColor ?? '#ffffff');
          const enabled = `between(t\\,${seconds(start)}\\,${seconds(end)})`;
          for (const line of layout) {
            const x = ffmpegCaptionX(line);
            const y = ffmpegCaptionY(line, height);
            const size = ffmpegCaptionFontSize(line);
            const textFilePath = join(textFileDirectory, `joy-text-${textFiles.length}.txt`);
            textFiles.push({
              path: textFilePath,
              content: wrapDrawtextDirection(line.text, resolveCaptionDirection(document)),
            });
            const next = `txt_${overlayIndex++}`;
            filters.push(
              `[${videoLabel}]drawtext=fontfile=${escapeFilterPath(fontPath)}:textfile=${escapeFilterPath(textFilePath)}:expansion=none${textCapabilities.textShapingOption ? ':text_shaping=1' : ''}:x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}:enable='${enabled}'[${next}]`,
            );
            videoLabel = next;
          }
        }
        continue;
      }
      if (clip.kind === 'composition') {
        skipped.push({
          clipId: clip.id,
          reason: 'nested composition clips are not supported by the v1 renderer',
        });
        continue;
      }
      const extendedClip = clip as unknown as Record<string, unknown>;
      if (Array.isArray(extendedClip.effects) && extendedClip.effects.length > 0) {
        skipped.push({
          clipId: clip.id,
          reason: 'clip effects are not supported by the v1 renderer',
        });
        continue;
      }
      const lookFilter = clip.kind === 'video' ? clipLookFilter(clip.look) : undefined;
      if (clip.kind === 'video' && clip.look !== undefined && !lookFilter) {
        skipped.push({ clipId: clip.id, reason: 'unknown or invalid clip look is not supported' });
        continue;
      }
      if (extendedClip.timeRemap !== undefined) {
        skipped.push({ clipId: clip.id, reason: 'timeRemap is not supported by the v1 renderer' });
      }
      const asset = project.assets[clip.assetId];
      const localPath = asset?.localSource?.path;
      if (!localPath) {
        skipped.push({ clipId: clip.id, reason: 'asset has no localSource path' });
        continue;
      }
      if (
        !isAbsolute(localPath) ||
        localPath.startsWith('-') ||
        !existsSync(localPath) ||
        !statSync(localPath).isFile()
      ) {
        skipped.push({
          clipId: clip.id,
          reason: 'asset localSource is not an existing absolute file',
        });
        continue;
      }
      const inputIndex = inputs.length + 1;
      inputs.push({ assetId: asset.id, path: localPath });
      if (asset.kind === 'image') args.push('-loop', '1', '-i', localPath);
      else args.push('-i', localPath);
      const rate = clip.playbackRate ?? 1;
      if (
        !Number.isSafeInteger(clip.startUs) ||
        clip.startUs < 0 ||
        !Number.isSafeInteger(clip.durationUs) ||
        clip.durationUs <= 0 ||
        !Number.isSafeInteger(clip.sourceInUs) ||
        clip.sourceInUs < 0 ||
        !Number.isFinite(rate) ||
        rate <= 0 ||
        rate > 8
      ) {
        skipped.push({
          clipId: clip.id,
          reason: 'clip timing or playback rate is invalid or unsupported',
        });
        continue;
      }
      if (asset.hasAudio === true && !isTrackMuted(track)) {
        const label = `a_${audioInputs.length}`;
        const atempo = atempoChain(rate);
        filters.push(
          `[${inputIndex}:a]atrim=start=${seconds(clip.sourceInUs)}:duration=${seconds(clip.durationUs * rate)},asetpts=PTS-STARTPTS,${atempo},adelay=${Math.round(clip.startUs / 1000)}|${Math.round(clip.startUs / 1000)}[${label}]`,
        );
        audioInputs.push(label);
      }
      const sourceDurationUs = clip.durationUs * (rate || 1);
      const label = `v_${overlayIndex}`;
      const reverse = clip.reversed ? ',reverse' : '';
      filters.push(
        `[${inputIndex}:v]trim=start=${seconds(clip.sourceInUs)}:duration=${seconds(sourceDurationUs)}${reverse},setpts=(PTS-STARTPTS)/${rate || 1}+${seconds(clip.startUs)}/TB${lookFilter ? `,${lookFilter}` : ''},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=yuva420p[${label}]`,
      );
      const next = `o_${overlayIndex}`;
      filters.push(
        `[${videoLabel}][${label}]overlay=eof_action=pass:enable='between(t,${seconds(clip.startUs)},${seconds(clip.startUs + clip.durationUs)})'[${next}]`,
      );
      videoLabel = next;
      overlayIndex += 1;
    }
  }
  for (const track of root.tracks
    .filter(
      (candidate) =>
        candidate.enabled !== false &&
        !isTrackMuted(candidate) &&
        (candidate.kind === 'audio' || candidate.family === 'audio'),
    )
    .sort((a, b) => a.order - b.order)) {
    for (const clip of [...track.clips].sort((a, b) => a.startUs - b.startUs)) {
      if (clip.kind !== 'video') {
        skipped.push({
          clipId: clip.id,
          reason: `${clip.kind} audio-track clips are not supported by the v1 renderer`,
        });
        continue;
      }
      const asset = project.assets[clip.assetId];
      const localPath = asset?.localSource?.path;
      if (
        !localPath ||
        !isAbsolute(localPath) ||
        localPath.startsWith('-') ||
        !existsSync(localPath) ||
        !statSync(localPath).isFile()
      ) {
        skipped.push({
          clipId: clip.id,
          reason: 'audio asset has no existing absolute localSource file',
        });
        continue;
      }
      const inputIndex =
        inputs.findIndex((input) => input.assetId === asset.id && input.path === localPath) + 1;
      let audioIndex = inputIndex;
      if (inputIndex === 0) {
        audioIndex = inputs.length + 1;
        inputs.push({ assetId: asset.id, path: localPath });
        args.push('-i', localPath);
      }
      const label = `a_${audioInputs.length}`;
      const rate = clip.playbackRate ?? 1;
      if (
        !Number.isSafeInteger(clip.startUs) ||
        clip.startUs < 0 ||
        !Number.isSafeInteger(clip.durationUs) ||
        clip.durationUs <= 0 ||
        !Number.isSafeInteger(clip.sourceInUs) ||
        clip.sourceInUs < 0 ||
        !Number.isFinite(rate) ||
        rate <= 0 ||
        rate > 8
      ) {
        skipped.push({
          clipId: clip.id,
          reason: 'audio clip timing or playback rate is invalid or unsupported',
        });
        continue;
      }
      const atempo = atempoChain(rate || 1);
      filters.push(
        `[${audioIndex}:a]atrim=start=${seconds(clip.sourceInUs)}:duration=${seconds(clip.durationUs * (rate || 1))},asetpts=PTS-STARTPTS,${atempo},adelay=${Math.round(clip.startUs / 1000)}|${Math.round(clip.startUs / 1000)}[${label}]`,
      );
      audioInputs.push(label);
    }
  }
  if (audioInputs.length === 0) {
    const silenceIndex = inputs.length + 1;
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    filters.push(`[${silenceIndex}:a]atrim=0:${duration},asetpts=PTS-STARTPTS[aout]`);
  } else {
    filters.push(
      `${audioInputs.map((label) => `[${label}]`).join('')}amix=inputs=${audioInputs.length}:normalize=0:duration=longest,apad,atrim=0:${duration}[aout]`,
    );
  }
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${videoLabel}]`,
    '-map',
    '[aout]',
    '-r',
    fpsExpr,
    '-t',
    duration,
    '-progress',
    'pipe:1',
    '-nostats',
    '-y',
  );
  if (presetId === 'mp4')
    args.push(
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '18',
      '-preset',
      'medium',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
    );
  else if (presetId === 'webm')
    args.push(
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '0',
      '-crf',
      '32',
      '-row-mt',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '160k',
    );
  else
    args.push(
      '-c:v',
      'prores_ks',
      '-profile:v',
      '3',
      '-pix_fmt',
      'yuv422p10le',
      '-c:a',
      'pcm_s24le',
    );
  return { args, inputs, skipped, width, height, fpsExpr, durationUs, textFiles };
}

export function clipLookFilter(look: unknown): string | undefined {
  if (look === undefined) return undefined;
  if (!look || typeof look !== 'object' || Array.isArray(look)) return undefined;
  const value = look as Record<string, unknown>;
  const bounded = (key: string, fallback: number): number | undefined => {
    const raw = value[key] ?? fallback;
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1
      ? raw
      : undefined;
  };
  const intensity = bounded('intensity', 1);
  if (intensity === undefined) return undefined;
  const amount = (n: number): string => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  switch (value.preset) {
    case 'crt': {
      const scanlines = bounded('scanlineStrength', 0.35);
      const noise = bounded('noiseAmount', 0.08);
      if (scanlines === undefined || noise === undefined) return undefined;
      return [
        `rgbashift=rh=${amount(2 * intensity)}:bh=${amount(-2 * intensity)}`,
        `noise=alls=${amount(12 * noise * intensity)}:allf=t+u`,
        `vignette=PI/${amount(4 / Math.max(0.1, intensity))}`,
        `drawgrid=width=iw:height=4:thickness=1:color=black@${amount(0.55 * scanlines * intensity)}`,
      ].join(',');
    }
    case 'bw':
      return `hue=s=${amount(1 - intensity)},eq=contrast=${amount(1 + 0.12 * intensity)}`;
    case 'warm':
      return `colorbalance=rs=${amount(0.3 * intensity)}:rm=${amount(0.22 * intensity)}:rh=${amount(0.12 * intensity)}:gs=${amount(0.02 * intensity)}:bs=${amount(-0.3 * intensity)}:bm=${amount(-0.22 * intensity)}:bh=${amount(-0.12 * intensity)}`;
    case 'cool':
      return `colorbalance=rs=${amount(-0.3 * intensity)}:rm=${amount(-0.22 * intensity)}:rh=${amount(-0.12 * intensity)}:gs=${amount(0.02 * intensity)}:bs=${amount(0.3 * intensity)}:bm=${amount(0.22 * intensity)}:bh=${amount(0.12 * intensity)}`;
    default:
      return undefined;
  }
}

function drawtextColor(value: string): string {
  const match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value);
  if (!match?.[1]) throw new RangeError('Caption color must be a 6- or 8-digit hexadecimal color.');
  return `0x${match[1]}`;
}

function positiveOverride(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 16 || result > maximum)
    throw new RangeError(`Render ${name} must be an integer from 16 through ${maximum}.`);
  return result;
}

function seconds(microseconds: number): string {
  return (microseconds / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function fitWithinMaxEdge(
  width: number,
  height: number,
  maxEdge: number,
): {
  width: number;
  height: number;
} {
  const scale = Math.min(1, maxEdge / width, maxEdge / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function safeColor(value: string): string {
  const match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value);
  return match?.[1] ? `0x${match[1]}` : 'black';
}

function atempoChain(rate: number): string {
  const parts: number[] = [];
  let remaining = rate;
  while (remaining > 2) {
    parts.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    parts.push(0.5);
    remaining /= 0.5;
  }
  parts.push(remaining);
  return parts.map((part) => `atempo=${part}`).join(',');
}

function isTrackMuted(track: {
  readonly id: string;
  readonly mute?: boolean;
  readonly muted?: boolean;
}): boolean {
  return track.mute === true || track.muted === true;
}
