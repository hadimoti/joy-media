import { spawnSync } from 'node:child_process';

export interface GpuPreviewProbeResult {
  readonly available: boolean;
  readonly renderer?: string;
  readonly backend?: string;
  readonly reason?: string;
}

export interface GpuPreviewProbeRunner {
  (
    command: string,
    args: readonly string[],
  ): { readonly status: number | null; readonly stdout?: string };
}

const SOFTWARE_RENDERER = /swiftshader|software|llvmpipe|softpipe|mesa offscreen/i;

/**
 * Worker-side capability probe. The probe executable is responsible for
 * creating the same graphics context used by the renderer and returning JSON:
 * `{ "hardware": true, "renderer": "...", "backend": "..." }`.
 *
 * Missing, malformed, software, or failed probes all fail closed. An
 * environment variable can select the executable, but cannot force success.
 */
export function probeHardwareGpuPreview(
  command = process.env.JOY_MEDIA_GPU_PREVIEW_PROBE?.trim(),
  run: GpuPreviewProbeRunner = (executable, args) => {
    const result = spawnSync(executable, [...args], { encoding: 'utf8', timeout: 5_000 });
    return { status: result.status, stdout: result.stdout };
  },
): GpuPreviewProbeResult {
  if (command === undefined || command.length === 0) {
    return { available: false, reason: 'hardware GPU probe executable is not configured' };
  }
  let result: { readonly status: number | null; readonly stdout?: string };
  try {
    result = run(command, ['--joy-gpu-preview-probe']);
  } catch (error) {
    return {
      available: false,
      reason: `hardware GPU probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return { available: false, reason: 'hardware GPU probe exited unsuccessfully' };
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return { available: false, reason: 'hardware GPU probe returned invalid JSON' };
    const value = parsed as Record<string, unknown>;
    const renderer = typeof value.renderer === 'string' ? value.renderer.trim() : '';
    const backend = typeof value.backend === 'string' ? value.backend.trim() : '';
    if (value.hardware !== true || renderer.length === 0 || backend.length === 0)
      return { available: false, reason: 'hardware GPU probe did not confirm a hardware renderer' };
    if (SOFTWARE_RENDERER.test(renderer) || SOFTWARE_RENDERER.test(backend))
      return { available: false, renderer, backend, reason: 'software renderer was detected' };
    return { available: true, renderer, backend };
  } catch {
    return { available: false, reason: 'hardware GPU probe returned invalid JSON' };
  }
}
