import { spawnSync } from 'node:child_process';

export interface FfmpegTextCapabilities {
  readonly textShaping: boolean;
  readonly textShapingOption: boolean;
}

const capabilityCache = new Map<string, FfmpegTextCapabilities>();

export function decideFfmpegTextCapabilities(
  drawtextHelp: string,
  buildconf: string,
): FfmpegTextCapabilities {
  const textShapingOption = /\btext_shaping\b/i.test(drawtextHelp);
  const textShaping =
    textShapingOption ||
    (/--enable-libfribidi\b/.test(buildconf) && /--enable-libharfbuzz\b/.test(buildconf));
  return { textShaping, textShapingOption };
}

export function probeFfmpegTextCapabilities(
  executable = process.env.JOY_FFMPEG?.trim() || 'ffmpeg',
): FfmpegTextCapabilities {
  const cached = capabilityCache.get(executable);
  if (cached) return cached;
  const help = spawnSync(executable, ['-hide_banner', '-h', 'filter=drawtext'], {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
  const helpText = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
  let buildconf = '';
  if (!/\btext_shaping\b/i.test(helpText)) {
    const build = spawnSync(executable, ['-buildconf'], {
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
    });
    buildconf = `${build.stdout ?? ''}\n${build.stderr ?? ''}`;
  }
  const capabilities = decideFfmpegTextCapabilities(helpText, buildconf);
  capabilityCache.set(executable, capabilities);
  return capabilities;
}
