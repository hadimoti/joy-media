/* global process */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.3gp': 'video/3gpp',
  '.ogv': 'video/ogg',
  '.mxf': 'application/mxf',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.mka': 'audio/x-matroska',
  '.oga': 'audio/ogg',
  '.avif': 'image/avif',
  '.apng': 'image/apng',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.vob': 'video/mpeg',
  '.m4b': 'audio/mp4',
};

export function mimeTypeFor(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** True when a name ends in a media extension this CLI knows (a file-like name, not a label). */
export function isMediaFileName(name: string): boolean {
  return Object.hasOwn(MIME_BY_EXTENSION, extname(name).toLowerCase());
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

export interface MediaProbeOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

type MediaProbeSpawn = (
  binary: string,
  args: string[],
  options: { readonly signal?: AbortSignal; readonly windowsHide?: boolean },
) => ChildProcess;
let mediaProbeSpawn: MediaProbeSpawn = (binary, args, options) => spawn(binary, args, options);

export function setMediaProbeSpawnForTests(spawner: MediaProbeSpawn | undefined): void {
  mediaProbeSpawn = spawner ?? ((binary, args, options) => spawn(binary, args, options));
}

/** Abortable ffprobe used by render paths that must respond promptly to cancellation. */
export async function probeMediaAsync(
  path: string,
  options: MediaProbeOptions = {},
): Promise<MediaInfo | null> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child: ChildProcess = mediaProbeSpawn(
    ffprobeBinary(),
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
    { windowsHide: true, ...(options.signal ? { signal: options.signal } : {}) },
  );
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (result: MediaInfo | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        reject(
          options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'),
        );
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may have exited at the same time as the cancellation.
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // A timed out process may already have exited.
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 16 * 1024 * 1024) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process may be exiting already.
        }
        finish(null);
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 16 * 1024 * 1024) finish(null);
    });
    child.once('error', () => finish(null));
    child.once('close', (status) => {
      if (status !== 0) return finish(null);
      let doc: { streams?: ProbeStream[]; format?: { format_name?: string; duration?: string } };
      try {
        doc = JSON.parse(output) as typeof doc;
      } catch {
        return finish(null);
      }
      const streams = doc.streams ?? [];
      const video = streams.find(
        (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
      );
      const audio = streams.find((stream) => stream.codec_type === 'audio');
      if (!video && !audio) return finish(null);
      const formatName = doc.format?.format_name ?? '';
      const isImage = Boolean(video) && !audio && /image2|_pipe|png|jpeg|webp|bmp/.test(formatName);
      const seconds = Number.parseFloat(
        doc.format?.duration ?? video?.duration ?? audio?.duration ?? '',
      );
      finish({
        hasVideo: Boolean(video),
        hasAudio: Boolean(audio),
        hasAlpha: /(?:rgba|bgra|argb|abgr|yuva|gbrap|ya8|gray\d*a)/u.test(video?.pix_fmt ?? ''),
        isImage,
        durationUs: Number.isFinite(seconds) && !isImage ? Math.round(seconds * 1_000_000) : 0,
        width: video?.width,
        height: video?.height,
        mimeType: mimeTypeFor(path),
      });
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
