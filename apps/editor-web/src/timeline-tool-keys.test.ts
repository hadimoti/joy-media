import { describe, expect, it } from 'vitest';
import { timelineToolKey } from './timeline-tool-keys.js';

const key = (k: string, extra: Partial<Parameters<typeof timelineToolKey>[0]> = {}) =>
  timelineToolKey({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...extra,
  });

describe('the Timeline tool keys', () => {
  it('maps the tools', () => {
    expect(key('v')).toBe('tool.select');
    expect(key('b')).toBe('tool.split');
    expect(key('m')).toBe('marker.add');
    expect(key('t')).toBe('track.addVisual');
    expect(key('a')).toBe('track.addAudio');
  });

  it('maps zoom and the shifted clip actions', () => {
    expect(key('=')).toBe('zoom.in');
    expect(key('+', { shiftKey: true })).toBe('zoom.in');
    expect(key('-')).toBe('zoom.out');
    expect(key('Z', { shiftKey: true })).toBe('zoom.fit');
    expect(key('F', { shiftKey: true })).toBe('clip.freeze');
    expect(key('R', { shiftKey: true })).toBe('clip.reverse');
    expect(key('Delete', { shiftKey: true })).toBe('clip.rippleDelete');
    expect(key('i', { ctrlKey: true })).toBe('media.import');
    expect(key('i', { metaKey: true })).toBe('media.import');
  });

  it('leaves the global keys alone', () => {
    expect(key('s')).toBeUndefined();
    expect(key('n')).toBeUndefined();
    expect(key('f')).toBeUndefined();
    expect(key('v', { ctrlKey: true })).toBeUndefined();
    expect(key('d', { metaKey: true })).toBeUndefined();
    expect(key('t', { altKey: true })).toBeUndefined();
  });
});
