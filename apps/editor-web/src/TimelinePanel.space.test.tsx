import { describe, expect, it } from 'vitest';
import { timelineClipSpaceBehavior } from './keyboard-shortcuts.js';

describe('timeline clip Space and Enter behavior', () => {
  it('lets selected clip Space bubble, selects an unselected clip, and keeps Enter selection', () => {
    expect(timelineClipSpaceBehavior(' ', true, false)).toBe('bubble');
    expect(timelineClipSpaceBehavior(' ', false, false)).toBe('select');
    expect(timelineClipSpaceBehavior('Enter', true, false)).toBe('select');
    expect(timelineClipSpaceBehavior(' ', true, true)).toBe('native');
  });
});
