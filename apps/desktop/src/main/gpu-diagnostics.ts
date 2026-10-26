/**
 * Diagnostic mode for the GPU investigation (L2, plan section 3.2). It is inert unless the app starts with
 * `--joy-media-gpu-diagnostics`, so a normal launch is unchanged. The switches below are candidates from the plan. Their
 * effect on this Electron build is not verified until the attended session G1 confirms each one, so they are data here,
 * not behaviour that any test claims to have observed.
 */
export const GPU_DIAGNOSTICS_FLAG = '--joy-media-gpu-diagnostics';

/** Only the exact flag switches diagnostic mode on. A similar argument, or the flag as part of a value, does not. */
export function isGpuDiagnosticsRequested(argv: readonly string[]): boolean {
  return argv.includes(GPU_DIAGNOSTICS_FLAG);
}

/** Stage probe, one fresh process per stage (plan section 3.2, step 2). S7 is the real export spec, run in G1. */
export const GPU_PROBE_STAGES = [
  { id: 'S0', name: 'idle' },
  { id: 'S1', name: 'WebGL canvas' },
  { id: 'S2', name: 'mediaCapabilities.encodingInfo' },
  { id: 'S3', name: 'VideoEncoder.isConfigSupported with hardware preferred' },
  { id: 'S4', name: 'encode one frame' },
  { id: 'S5', name: 'MediaRecorder H.264 from a canvas stream' },
  { id: 'S6', name: 'S5 plus WebGL' },
  { id: 'S7', name: 'the real export spec' },
] as const;

export type GpuProbeStageId = (typeof GPU_PROBE_STAGES)[number]['id'];

/**
 * Candidate Chromium logging switches for the GPU and media-foundation modules. Each is unverified until G1 confirms it on
 * this build: a switch that does not exist is ignored, so a wrong one shows as missing output, not as a crash.
 */
export const GPU_DIAGNOSTIC_CHROMIUM_SWITCHES: readonly {
  readonly name: string;
  readonly value: string;
}[] = [
  { name: 'enable-logging', value: 'file' },
  { name: 'v', value: '1' },
  { name: 'vmodule', value: '*/media/gpu/*=2,*media_foundation*=2' },
];

/** Crash dumps stay on this PC. Nothing is uploaded, so a diagnostic run cannot send a report anywhere. */
export const GPU_DIAGNOSTIC_CRASH_REPORTER = { uploadToServer: false } as const;

/** The command-line switches that diagnostic mode adds, in the form Chromium reads them. */
export function gpuDiagnosticSwitchArguments(): readonly string[] {
  return GPU_DIAGNOSTIC_CHROMIUM_SWITCHES.map((entry) => `--${entry.name}=${entry.value}`);
}
