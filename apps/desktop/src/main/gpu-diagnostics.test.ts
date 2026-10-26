import { describe, expect, it } from 'vitest';
import {
  GPU_DIAGNOSTIC_CHROMIUM_SWITCHES,
  GPU_DIAGNOSTIC_CRASH_REPORTER,
  GPU_DIAGNOSTIC_UNUSED_SUBMIT_URL,
  GPU_DIAGNOSTICS_FLAG,
  GPU_PROBE_STAGES,
  gpuDiagnosticSwitchArguments,
  installGpuDiagnostics,
  isGpuDiagnosticsRequested,
  type GpuDiagnosticsHost,
} from './gpu-diagnostics.js';

function fakeHost(): {
  readonly host: GpuDiagnosticsHost;
  readonly crashStarts: unknown[];
  readonly switches: [string, string | undefined][];
  readonly lines: string[];
  readonly emitGone: (details: unknown) => void;
  readonly emitReady: () => void;
} {
  const crashStarts: unknown[] = [];
  const switches: [string, string | undefined][] = [];
  const lines: string[] = [];
  let gone: ((details: unknown) => void) | undefined;
  let ready: (() => void) | undefined;
  const host: GpuDiagnosticsHost = {
    commandLine: {
      appendSwitch: (name, value) => {
        switches.push([name, value]);
      },
    },
    crashReporter: {
      start: (options) => {
        crashStarts.push(options);
      },
    },
    onChildProcessGone: (listener) => {
      gone = listener;
    },
    onReady: (callback) => {
      ready = callback;
    },
    gpuState: async () => ({
      info: { gpuDevice: [{ active: true }] },
      features: { webgl: 'enabled' },
    }),
    log: (line) => {
      lines.push(line);
    },
  };
  return {
    host,
    crashStarts,
    switches,
    lines,
    emitGone: (details) => gone?.(details),
    emitReady: () => ready?.(),
  };
}

describe('GPU diagnostic mode switch', () => {
  it('stays off for a normal launch and for a similar argument', () => {
    expect(isGpuDiagnosticsRequested([])).toBe(false);
    expect(isGpuDiagnosticsRequested(['joy-media.exe', '--smoke'])).toBe(false);
    expect(isGpuDiagnosticsRequested([`${GPU_DIAGNOSTICS_FLAG}-extra`])).toBe(false);
    expect(isGpuDiagnosticsRequested([`--note=${GPU_DIAGNOSTICS_FLAG}`])).toBe(false);
  });

  it('turns on only for the exact flag', () => {
    expect(isGpuDiagnosticsRequested(['joy-media.exe', GPU_DIAGNOSTICS_FLAG])).toBe(true);
  });
});

describe('GPU diagnostic settings', () => {
  it('keeps crash dumps on this PC and uploads nothing', () => {
    expect(GPU_DIAGNOSTIC_CRASH_REPORTER).toEqual({ uploadToServer: false });
  });

  it('adds Chromium logging switches in the form the command line expects', () => {
    const switches = gpuDiagnosticSwitchArguments();
    expect(switches.length).toBeGreaterThan(0);
    for (const argument of switches) expect(argument).toMatch(/^--[a-z-]+=.+$/u);
    expect(switches).toContain('--enable-logging=file');
  });

  it('lists the eight stages from the plan, each once, with the real export spec last', () => {
    const ids = GPU_PROBE_STAGES.map((stage) => stage.id);
    expect(ids).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GPU_PROBE_STAGES[GPU_PROBE_STAGES.length - 1]?.name).toBe('the real export spec');
  });
});

describe('GPU diagnostic wiring', () => {
  it('does nothing for a normal launch: no crash reporter, no switches, no log', () => {
    const fake = fakeHost();
    expect(installGpuDiagnostics(fake.host, ['joy-media.exe', '--smoke'])).toBe(false);
    expect(fake.crashStarts).toEqual([]);
    expect(fake.switches).toEqual([]);
    fake.emitGone({ type: 'GPU', exitCode: -1073740791 });
    fake.emitReady();
    expect(fake.lines).toEqual([]);
  });

  it('starts local-only crash reporting and adds the candidate switches before ready', () => {
    const fake = fakeHost();
    expect(installGpuDiagnostics(fake.host, ['joy-media.exe', GPU_DIAGNOSTICS_FLAG])).toBe(true);
    expect(fake.crashStarts).toEqual([
      { ...GPU_DIAGNOSTIC_CRASH_REPORTER, submitURL: GPU_DIAGNOSTIC_UNUSED_SUBMIT_URL },
    ]);
    expect(fake.switches).toEqual(
      GPU_DIAGNOSTIC_CHROMIUM_SWITCHES.map((entry) => [entry.name, entry.value]),
    );
    expect(fake.lines[0]).toContain('gpu-diagnostics-enabled');
  });

  it('logs child-process exits with only the explaining fields', () => {
    const fake = fakeHost();
    installGpuDiagnostics(fake.host, [GPU_DIAGNOSTICS_FLAG]);
    fake.emitGone({
      type: 'GPU',
      reason: 'crashed',
      exitCode: -1073740791,
      serviceName: 'gpu',
      name: 'GPU Process',
      pid: 4242,
      path: 'C:/Users/someone/joy-media.exe',
    });
    const exit = JSON.parse(fake.lines[fake.lines.length - 1] ?? '{}') as Record<string, unknown>;
    expect(exit).toEqual({
      event: 'child-process-gone',
      type: 'GPU',
      reason: 'crashed',
      exitCode: -1073740791,
      serviceName: 'gpu',
      name: 'GPU Process',
    });
    expect(JSON.stringify(exit)).not.toContain('someone');
  });

  it('records the GPU state once the app is ready, and a failed read as a line, not a throw', async () => {
    const fake = fakeHost();
    installGpuDiagnostics(fake.host, [GPU_DIAGNOSTICS_FLAG]);
    fake.emitReady();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fake.lines.some((line) => line.includes('"event":"gpu-state"'))).toBe(true);
    expect(fake.lines.some((line) => line.includes('"features"'))).toBe(true);

    const failing = fakeHost();
    const failingHost: GpuDiagnosticsHost = {
      ...failing.host,
      gpuState: () => Promise.reject(new Error('GPU info unavailable')),
    };
    installGpuDiagnostics(failingHost, [GPU_DIAGNOSTICS_FLAG]);
    failing.emitReady();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(failing.lines.some((line) => line.includes('gpu-state-failed'))).toBe(true);
  });
});
