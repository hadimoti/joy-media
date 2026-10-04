import { describe, expect, it } from 'vitest';
import { decideFfmpegTextCapabilities } from './text-capabilities.js';

describe('FFmpeg text shaping capability detection', () => {
  it('recognizes the drawtext option and adds it when available', () => {
    expect(
      decideFfmpegTextCapabilities('drawtext AVOptions:\n text_shaping <boolean>', ''),
    ).toEqual({
      textShaping: true,
      textShapingOption: true,
    });
  });

  it('recognizes builds configured with both fribidi and harfbuzz', () => {
    expect(decideFfmpegTextCapabilities('', '--enable-libfribidi --enable-libharfbuzz')).toEqual({
      textShaping: true,
      textShapingOption: false,
    });
  });

  it('does not treat fribidi without harfbuzz as complete shaping support', () => {
    expect(decideFfmpegTextCapabilities('', '--enable-libfribidi')).toEqual({
      textShaping: false,
      textShapingOption: false,
    });
  });

  it('detects builds with neither feature', () => {
    expect(decideFfmpegTextCapabilities('text_shaping (boolean)', '--disable-libfribidi')).toEqual({
      textShaping: true,
      textShapingOption: true,
    });
    expect(decideFfmpegTextCapabilities('', '--disable-libfribidi --disable-libharfbuzz')).toEqual({
      textShaping: false,
      textShapingOption: false,
    });
  });
});
