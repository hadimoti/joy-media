import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface MediaTools {
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly ready: boolean;
  readonly reason?: string;
}

/** Resolve both tools explicitly. Missing or non-executable tools fail closed. */
export function discoverMediaTools(
  configured: { readonly ffmpegPath?: string; readonly ffprobePath?: string },
  platform: NodeJS.Platform = process.platform,
  run: (command: string) => boolean = (command) =>
    spawnSync(command, ['-version'], { shell: false, stdio: 'ignore' }).status === 0,
  exists: (path: string) => boolean = existsSync,
): MediaTools {
  const resolve = (
    name: 'ffmpeg' | 'ffprobe',
    configuredPath: string | undefined,
  ): string | undefined => {
    if (configuredPath !== undefined && configuredPath.trim() !== '')
      return exists(configuredPath) && run(configuredPath) ? configuredPath : undefined;
    const command = platform === 'win32' ? `${name}.exe` : name;
    return run(command) ? command : undefined;
  };
  const ffmpegPath = resolve('ffmpeg', configured.ffmpegPath);
  const ffprobePath = resolve('ffprobe', configured.ffprobePath);
  return ffmpegPath !== undefined && ffprobePath !== undefined
    ? { ffmpegPath, ffprobePath, ready: true }
    : {
        ready: false,
        ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
        ...(ffprobePath === undefined ? {} : { ffprobePath }),
        reason: 'FFmpeg and ffprobe are both required and must be executable',
      };
}
