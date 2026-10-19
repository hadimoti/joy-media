/* global process */
import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';

/** What the CLI needs to know about a media file to put it on a timeline and render it. */
export interface MediaInfo {
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly hasAlpha: boolean;
  /** A still picture (png/jpg/webp/...): no timeline length of its own. */
  readonly isImage: boolean;
  readonly durationUs: number;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly mimeType: string;
}

/** `JOY_MEDIA_FFMPEG` / `JOY_MEDIA_FFPROBE` override the binaries (PATH lookup otherwise). */
export function ffmpegBinary(): string {
  return process.env.JOY_MEDIA_FFMPEG?.trim() || 'ffmpeg';
}

export function ffprobeBinary(): string {
  return process.env.JOY_MEDIA_FFPROBE?.trim() || 'ffprobe';
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export function mimeTypeFor(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

interface ProbeStream {
  readonly codec_type?: string;
  readonly width?: number;
  readonly height?: number;
  readonly pix_fmt?: string;
  readonly duration?: string;
  readonly disposition?: { readonly attached_pic?: number };
}

/**
 * Inspect a media file with ffprobe. Returns `null` when ffprobe is missing or the file is not
 * readable media; callers decide how loudly to complain.
 */
export function probeMedia(path: string): MediaInfo | null {
  const res = spawnSync(
    ffprobeBinary(),
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.error || res.status !== 0) return null;
  let doc: { streams?: ProbeStream[]; format?: { format_name?: string; duration?: string } };
  try {
    doc = JSON.parse(res.stdout) as typeof doc;
  } catch {
    return null;
  }
  const streams = doc.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video && !audio) return null;
  const formatName = doc.format?.format_name ?? '';
  const isImage = Boolean(video) && !audio && /image2|_pipe|png|jpeg|webp|bmp/.test(formatName);
  const seconds = Number.parseFloat(
    doc.format?.duration ?? video?.duration ?? audio?.duration ?? '',
  );
  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    hasAlpha: /(?:rgba|bgra|argb|abgr|yuva|gbrap|ya8|gray\d*a)/u.test(video?.pix_fmt ?? ''),
    isImage,
    durationUs: Number.isFinite(seconds) && !isImage ? Math.round(seconds * 1_000_000) : 0,
    width: video?.width,
    height: video?.height,
    mimeType: mimeTypeFor(path),
  };
}
