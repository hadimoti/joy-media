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

/** Electron requires a submit URL. Uploads are off, and `.invalid` never resolves, so nothing is sent to it. */
export const GPU_DIAGNOSTIC_UNUSED_SUBMIT_URL = 'https://crash-reports.invalid/unused';

/** What diagnostic mode needs from Electron. The entry point passes the real objects, and tests pass fakes. */
export interface GpuDiagnosticsHost {
  readonly commandLine: { appendSwitch(name: string, value?: string): void };
  readonly crashReporter: { start(options: { uploadToServer: boolean; submitURL: string }): void };
  readonly onChildProcessGone: (listener: (details: unknown) => void) => void;
  readonly onReady: (callback: () => void) => void;
  readonly gpuState: () => Promise<{ readonly info: unknown; readonly features: unknown }>;
  readonly log: (line: string) => void;
}

/** Keeps only the fields that explain a child-process exit, so a diagnostic line never carries anything else. */
function childProcessFields(details: unknown): Record<string, unknown> {
  const record =
    typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {};
  return {
    type: record['type'],
    reason: record['reason'],
    exitCode: record['exitCode'],
    serviceName: record['serviceName'],
    name: record['name'],
  };
}

/**
 * Turns diagnostic mode on only when the flag is present, and returns whether it did. Crash reporting and the Chromium
 * switches are set before the app is ready, because Chromium reads them at startup. The GPU snapshot waits for ready.
 */
export function installGpuDiagnostics(host: GpuDiagnosticsHost, argv: readonly string[]): boolean {
  if (!isGpuDiagnosticsRequested(argv)) return false;
  host.crashReporter.start({
    ...GPU_DIAGNOSTIC_CRASH_REPORTER,
    submitURL: GPU_DIAGNOSTIC_UNUSED_SUBMIT_URL,
  });
  for (const entry of GPU_DIAGNOSTIC_CHROMIUM_SWITCHES) {
    host.commandLine.appendSwitch(entry.name, entry.value);
  }
  host.log(
    JSON.stringify({ event: 'gpu-diagnostics-enabled', switches: gpuDiagnosticSwitchArguments() }),
  );
  host.onChildProcessGone((details) =>
    host.log(JSON.stringify({ event: 'child-process-gone', ...childProcessFields(details) })),
  );
  host.onReady(() => {
    void host.gpuState().then(
      (state) => host.log(JSON.stringify({ event: 'gpu-state', ...state })),
      (error: unknown) =>
        host.log(
          JSON.stringify({
            event: 'gpu-state-failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
    );
  });
  return true;
}
