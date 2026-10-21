import { execFile } from 'node:child_process';

/**
 * Whether a staged video has an audio stream, as reported by ffprobe.
 *
 * `unknown` is returned whenever ffprobe cannot answer (not installed, timed out, unreadable
 * file). It is never folded into `absent`: a probe failure must not be read as proof that a file
 * is silent.
 */
export type AudioPresence =
  | { readonly status: 'present'; readonly streams: number }
  | { readonly status: 'absent' }
  | { readonly status: 'unknown'; readonly reason: string };

export type RunProbe = (args: readonly string[]) => Promise<{ readonly stdout: string }>;

const PROBE_TIMEOUT_MS = 20_000;

const runFfprobe: RunProbe = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      [...args],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout });
      },
    );
  });

/** Counts audio streams with ffprobe, reading stream headers only (no decode). */
export async function probeAudioPresence(
  path: string,
  run: RunProbe = runFfprobe,
): Promise<AudioPresence> {
  let stdout: string;
  try {
    ({ stdout } = await run([
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      path,
    ]));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT'
        ? 'ffprobe is not installed'
        : error instanceof Error
          ? error.message
          : 'ffprobe failed';
    return { status: 'unknown', reason };
  }
  const streams = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  return streams > 0 ? { status: 'present', streams } : { status: 'absent' };
}
