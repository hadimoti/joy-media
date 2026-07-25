import { describe, expect, it } from 'vitest';
import { effectToFfmpegFilter, effectStackToFfmpegFiltergraph } from './ffmpeg-backend.js';

describe('ffmpeg-backend', () => {
  it('brightness-contrast produces eq filter', () => {
    const result = effectToFfmpegFilter(
      { id: 'e1', effectId: 'brightness-contrast', enabled: true, params: { brightness: 0, contrast: 0 } },
      '0:v', 'e1',
    );
    expect(result).toBe('[0:v]eq=brightness=0.00:contrast=1.00[e1]');
  });

  it('brightness-contrast with non-zero params', () => {
    const result = effectToFfmpegFilter(
      { id: 'e1', effectId: 'brightness-contrast', enabled: true, params: { brightness: 0.1, contrast: 0.2 } },
      '0:v', 'e1',
    );
    expect(result).toContain('brightness=25.50');
    expect(result).toContain('contrast=1.20');
  });

  it('sepia produces colorchannelmixer filter', () => {
    const result = effectToFfmpegFilter(
      { id: 'e1', effectId: 'sepia', enabled: true, params: { amount: 0.5 } },
      'in', 'out',
    );
    expect(result).toContain('colorchannelmixer');
    expect(result).toContain('[in]');
    expect(result).toContain('[out]');
  });

  it('gaussian-blur produces gblur filter', () => {
    const result = effectToFfmpegFilter(
      { id: 'e1', effectId: 'gaussian-blur', enabled: true, params: { amount: 4 } },
      '0:v', 'blurred',
    );
    expect(result).toBe('[0:v]gblur=sigma=4.0[blurred]');
  });

  it('hue-saturation produces hue filter', () => {
    const result = effectToFfmpegFilter(
      { id: 'e1', effectId: 'hue-saturation', enabled: true, params: { hue: 0.1, saturation: 0.3 } },
      '0:v', 'out',
    );
    expect(result).toContain('hue=');
    expect(result).toContain('h=18.0');
    expect(result).toContain('s=1.30');
  });

  it('unknown effect returns undefined', () => {
    const result = effectToFfmpegFilter(
      { id: 'e1', effectId: 'nonexistent-effect', enabled: true, params: {} },
      '0:v', 'e1',
    );
    expect(result).toBeUndefined();
  });

  it('disabled effect returns undefined', () => {
    const result = effectToFfmpegFilter(
      { id: 'e1', effectId: 'brightness-contrast', enabled: false, params: { brightness: 0.5, contrast: 0.5 } },
      '0:v', 'e1',
    );
    expect(result).toBeUndefined();
  });

  it('effectStackToFfmpegFiltergraph chains multiple filters', () => {
    const result = effectStackToFfmpegFiltergraph([
      { id: 'e1', effectId: 'brightness-contrast', enabled: true, params: { brightness: 0.05, contrast: 0.1 } },
      { id: 'e2', effectId: 'gaussian-blur', enabled: true, params: { amount: 3 } },
    ]);
    expect(result).toBeDefined();
    expect(result).toContain('eq=brightness');
    expect(result).toContain('gblur');
  });

  it('effectStackToFfmpegFiltergraph handles empty input', () => {
    expect(effectStackToFfmpegFiltergraph([])).toBeUndefined();
    expect(effectStackToFfmpegFiltergraph([{ id: 'e1', effectId: 'brightness-contrast', enabled: false, params: {} }])).toBeUndefined();
  });
});
