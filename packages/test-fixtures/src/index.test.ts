import { describe, expect, it } from 'vitest';
import {
  buildReferenceSpikeProject,
  createTimelineScaleFixture,
  PACKAGE_NAME,
  REFERENCE_PROJECT,
  TIMELINE_SCALE_REFERENCE,
} from './index.js';

describe('@joy-media/test-fixtures scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@joy-media/test-fixtures');
  });
  it('provides a 30-second dual-format social-edit acceptance fixture', () => {
    expect(REFERENCE_PROJECT.durationUs).toBe(30_000_000);
    expect(REFERENCE_PROJECT.formats).toEqual([
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
    ]);
  });

  it('builds the complete 30-second editable fixture', () => {
    const project = buildReferenceSpikeProject();
    expect(project.id).toBe(REFERENCE_PROJECT.id);
    expect(project.compositions.root?.durationUs).toBe(30_000_000);
    expect(project.compositions.root?.tracks.flatMap((track) => track.clips)).toHaveLength(5);
  });

  it('creates a CI-friendly §30.3 scale fixture and retains the full target profile', () => {
    const fixture = createTimelineScaleFixture();
    expect(fixture).toMatchObject({
      version: 1,
      profile: 'scaled-down',
      counts: { trackCount: 10, clipCount: 1_000, captionWordCount: 10_000 },
    });
    expect(fixture.assets).toHaveLength(500);
    expect(TIMELINE_SCALE_REFERENCE).toMatchObject({
      durationUs: 3_600_000_000,
      trackCount: 100,
      clipCount: 10_000,
      captionWordCount: 100_000,
      keyframeCount: 50_000,
      assetCount: 5_000,
    });
  });
});
