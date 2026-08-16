import { describe, expect, it } from 'vitest';
import { probeHardwareGpuPreview } from './gpu-preview-probe.js';

describe('hardware GPU preview probe', () => {
  it('fails closed when no probe is configured', () => {
    expect(probeHardwareGpuPreview(undefined).available).toBe(false);
  });

  it('accepts only an explicit hardware renderer result', () => {
    const run = (_command: string, _args: readonly string[]) => ({
      status: 0,
      stdout: JSON.stringify({ hardware: true, renderer: 'NVIDIA RTX', backend: 'D3D11' }),
    });
    expect(probeHardwareGpuPreview('probe.exe', run)).toEqual({
      available: true,
      renderer: 'NVIDIA RTX',
      backend: 'D3D11',
    });
  });

  it('rejects SwiftShader/software output even when it claims hardware', () => {
    const run = (_command: string, _args: readonly string[]) => ({
      status: 0,
      stdout: JSON.stringify({ hardware: true, renderer: 'ANGLE SwiftShader', backend: 'Vulkan' }),
    });
    expect(probeHardwareGpuPreview('probe.exe', run).available).toBe(false);
  });
});
