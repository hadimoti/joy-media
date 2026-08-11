import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panelSource = readFileSync(new URL('./TimelinePanel.tsx', import.meta.url), 'utf8');

describe('Timeline arbitrary-duration fit and playback follow contract', () => {
  it('uses authored content duration for fit, ruler, lanes, seek, and trim bounds', () => {
    expect(panelSource).toContain('const timelineDurationUs = timelineEffectiveDurationUs(');
    expect(panelSource).not.toContain('fitPixelsPerSecond(composition.durationUs');
    expect(panelSource).not.toContain('durationUs={composition.durationUs}');
    expect(panelSource).toContain('durationUs={timelineDurationUs}');
    expect(panelSource).toContain('maxStartUs={timelineDurationUs - clip.durationUs}');
  });

  it('page-follows a playing, zoomed playhead and resets Fit to the first page', () => {
    expect(panelSource).toContain('if (!playing || autoFit) return;');
    expect(panelSource).toContain('timelineFollowScrollLeft({');
    expect(panelSource).toContain('root.scrollLeft = next');
    expect(panelSource).toContain('scrollRef.current.scrollLeft = 0');
  });
});
