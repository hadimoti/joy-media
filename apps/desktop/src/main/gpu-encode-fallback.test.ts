import { describe, expect, it } from 'vitest';
import {
  GPU_ENCODE_FALLBACK_ARGUMENT,
  GPU_ENCODE_FALLBACK_FEATURE,
  GPU_FAST_FAIL_EXIT_CODE,
  applyGpuEncodeFallback,
  installGpuEncodeFallback,
  isGpuFastFail,
  shouldRelaunchForGpuEncodeFallback,
  type GpuChildProcessGone,
  type GpuEncodeFallbackHost,
} from './gpu-encode-fallback.js';

const fastFail: GpuChildProcessGone = {
  type: 'GPU',
  reason: 'crashed',
  exitCode: GPU_FAST_FAIL_EXIT_CODE,
};
const launchArgv = ['joy-media.exe', '--some-flag'];
const fallbackArgv = [...launchArgv, GPU_ENCODE_FALLBACK_ARGUMENT];

function recordingHost(argv: readonly string[]) {
  const switches: { name: string; value?: string | undefined }[] = [];
  const relaunches: { args: string[] }[] = [];
  const logs: string[] = [];
  let quits = 0;
  let listener: ((details: GpuChildProcessGone) => void) | undefined;
  const host: GpuEncodeFallbackHost = {
    commandLine: { appendSwitch: (name, value) => switches.push({ name, value }) },
    relaunch: (options) => relaunches.push(options),
    quit: () => {
      quits += 1;
    },
    onChildProcessGone: (next) => {
      listener = next;
    },
    log: (message) => logs.push(message),
  };
  installGpuEncodeFallback(host, argv);
  return {
    switches,
    relaunches,
    logs,
    quits: () => quits,
    emit: (details: GpuChildProcessGone) => listener?.(details),
  };
}

describe('GPU encode fallback', () => {
  it('recognises only a GPU process fast-fail with the observed exit code', () => {
    expect(isGpuFastFail(fastFail)).toBe(true);
    expect(isGpuFastFail({ ...fastFail, type: 'Utility' })).toBe(false);
    expect(isGpuFastFail({ ...fastFail, exitCode: 0 })).toBe(false);
    // An access violation is a different failure. It must not trigger the feature fallback.
    expect(isGpuFastFail({ ...fastFail, exitCode: -1073741819 })).toBe(false);
  });

  it('relaunches once after a GPU fast-fail, and never from the fallback session', () => {
    expect(shouldRelaunchForGpuEncodeFallback(fastFail, launchArgv)).toBe(true);
    expect(shouldRelaunchForGpuEncodeFallback(fastFail, fallbackArgv)).toBe(false);
    expect(shouldRelaunchForGpuEncodeFallback({ ...fastFail, type: 'Utility' }, launchArgv)).toBe(
      false,
    );
  });

  it('turns off only the Media Foundation video encoder feature, and only in the fallback session', () => {
    const normal = recordingHost(launchArgv);
    expect(normal.switches).toEqual([]);
    const fallback = recordingHost(fallbackArgv);
    expect(fallback.switches).toEqual([
      { name: 'disable-features', value: GPU_ENCODE_FALLBACK_FEATURE },
    ]);
    // Neither sandboxing nor hardware encoding as a whole is switched off.
    expect(fallback.switches.map((entry) => entry.name)).not.toContain('disable-gpu-sandbox');
    expect(fallback.switches.map((entry) => entry.name)).not.toContain(
      'disable-accelerated-video-encode',
    );
    expect(applyGpuEncodeFallback({ appendSwitch: () => undefined }, launchArgv)).toBe(false);
  });

  it('relaunches with the fallback argument, then quits, after a first GPU fast-fail', () => {
    const session = recordingHost(launchArgv);
    session.emit(fastFail);
    expect(session.relaunches).toEqual([
      { args: [...launchArgv.slice(1), GPU_ENCODE_FALLBACK_ARGUMENT] },
    ]);
    expect(session.quits()).toBe(1);
    expect(session.logs).toHaveLength(1);
  });

  it('relaunches once even when a second fast-fail arrives during the quit', () => {
    const session = recordingHost(launchArgv);
    session.emit(fastFail);
    session.emit(fastFail);
    expect(session.relaunches).toHaveLength(1);
    expect(session.quits()).toBe(1);
  });

  it('does not relaunch again when the fallback session also fast-fails', () => {
    const session = recordingHost(fallbackArgv);
    session.emit(fastFail);
    expect(session.relaunches).toEqual([]);
    expect(session.quits()).toBe(0);
    expect(session.logs.some((message) => message.includes('not relaunching again'))).toBe(true);
  });

  it('ignores other child-process exits in a normal launch', () => {
    const session = recordingHost(launchArgv);
    session.emit({ ...fastFail, type: 'Utility' });
    session.emit({ type: 'GPU', reason: 'clean-exit', exitCode: 0 });
    expect(session.relaunches).toEqual([]);
    expect(session.quits()).toBe(0);
    expect(session.logs).toEqual([]);
  });
});
