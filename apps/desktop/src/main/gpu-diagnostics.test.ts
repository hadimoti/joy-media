import { describe, expect, it } from 'vitest';
import {
  GPU_DIAGNOSTIC_CRASH_REPORTER,
  GPU_DIAGNOSTICS_FLAG,
  GPU_PROBE_STAGES,
  gpuDiagnosticSwitchArguments,
  isGpuDiagnosticsRequested,
} from './gpu-diagnostics.js';

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
