/**
 * Crash-triggered, per-launch fallback for the Media Foundation video encoder.
 *
 * On an NVIDIA RTX 50-series host with driver 617.42, the GPU process fast-fails with
 * STATUS_STACK_BUFFER_OVERRUN (0xC0000409) during media setup, and WebGL is lost for the session.
 * Measured on the packaged build: turning off the Media Foundation video encoder feature stops the
 * crash, while turning off the video decoder or stubbing the encode-support probe does not. Hardware
 * encoding is unchanged for every launch that does not crash. The fallback applies only to a
 * relaunch that follows a crash, and nothing is persisted. A relaunched session that crashes again
 * is not relaunched again. GPU sandboxing is never touched.
 */

/** Relaunch argument that marks the session as the fallback session. */
export const GPU_ENCODE_FALLBACK_ARGUMENT = '--joy-media-gpu-encode-fallback';

/** Chromium feature that turns off the Media Foundation video encoder. */
export const GPU_ENCODE_FALLBACK_FEATURE = 'MediaFoundationVideoEncodeAccelerator';

/** Exit code of a GPU process fast-fail (0xC0000409), as Electron reports it on Windows. */
export const GPU_FAST_FAIL_EXIT_CODE = -1073740791;

export interface GpuChildProcessGone {
  readonly type: string;
  readonly reason: string;
  readonly exitCode: number;
}

export interface GpuEncodeFallbackHost {
  readonly commandLine: { appendSwitch(name: string, value?: string): void };
  relaunch(options: { readonly args: string[] }): void;
  quit(): void;
  onChildProcessGone(listener: (details: GpuChildProcessGone) => void): void;
  log(message: string): void;
}

export function isGpuFastFail(details: GpuChildProcessGone): boolean {
  return details.type === 'GPU' && details.exitCode === GPU_FAST_FAIL_EXIT_CODE;
}

export function isFallbackSession(argv: readonly string[]): boolean {
  return argv.includes(GPU_ENCODE_FALLBACK_ARGUMENT);
}

/** A crash relaunches once. A session that is already the fallback never relaunches again. */
export function shouldRelaunchForGpuEncodeFallback(
  details: GpuChildProcessGone,
  argv: readonly string[],
): boolean {
  return isGpuFastFail(details) && !isFallbackSession(argv);
}

/** Applies the feature switch, and only to a fallback session. Returns whether it applied. */
export function applyGpuEncodeFallback(
  commandLine: GpuEncodeFallbackHost['commandLine'],
  argv: readonly string[],
): boolean {
  if (!isFallbackSession(argv)) return false;
  commandLine.appendSwitch('disable-features', GPU_ENCODE_FALLBACK_FEATURE);
  return true;
}

/**
 * Call before the app is ready, because Chromium reads switches at startup. Wires the crash
 * relaunch to the GPU child-process event.
 */
export function installGpuEncodeFallback(
  host: GpuEncodeFallbackHost,
  argv: readonly string[],
): void {
  applyGpuEncodeFallback(host.commandLine, argv);
  // A second fast-fail can arrive while the first quit is in progress. Relaunch at most once.
  let relaunching = false;
  host.onChildProcessGone((details) => {
    if (!shouldRelaunchForGpuEncodeFallback(details, argv)) {
      if (isGpuFastFail(details) && isFallbackSession(argv))
        host.log('GPU fast-fail in the encode-fallback session; not relaunching again.');
      return;
    }
    if (relaunching) return;
    relaunching = true;
    host.log(
      'GPU process fast-failed during media setup; relaunching once with the Media Foundation video encoder off.',
    );
    // Quit rather than exit: app.exit skips before-quit, which stops the Worker and closes the local
    // database. app.relaunch starts the new instance only after this one exits, so the
    // single-instance lock is not contended.
    host.relaunch({ args: [...argv.slice(1), GPU_ENCODE_FALLBACK_ARGUMENT] });
    host.quit();
  });
}
