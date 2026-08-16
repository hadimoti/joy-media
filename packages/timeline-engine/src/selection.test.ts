import { describe, expect, it } from 'vitest';
import { applyTimelineSelection } from './index.js';

describe('applyTimelineSelection', () => {
  it('replaces a previous selection on an ordinary click', () => {
    expect(applyTimelineSelection({ clipIds: ['intro'] }, 'replace', ['product'])).toEqual({
      clipIds: ['product'],
    });
  });

  it('toggles only when the caller explicitly asks for an additive gesture', () => {
    expect(applyTimelineSelection({ clipIds: ['product'] }, 'toggle', ['intro'])).toEqual({
      clipIds: ['product', 'intro'],
    });
    expect(
      applyTimelineSelection({ clipIds: ['product', 'intro'] }, 'toggle', ['product']),
    ).toEqual({
      clipIds: ['intro'],
    });
  });

  it('keeps the clicked clip selected when a normal click collapses a group', () => {
    expect(applyTimelineSelection({ clipIds: ['intro', 'product'] }, 'replace', ['intro'])).toEqual(
      {
        clipIds: ['intro'],
      },
    );
  });
});
