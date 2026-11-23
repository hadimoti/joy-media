import { describe, expect, it } from 'vitest';
import { IDENTITY_CAPTION_CLIP_STYLE } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { compileJoyCodeCaptionOperation } from './joy-code-caption-operations.js';

describe('Joy Code caption operations', () => {
  it('updates segment text and timing', () => {
    const text = compileJoyCodeCaptionOperation({
      project: INITIAL_EDITOR_PROJECT,
      operation: {
        id: 'text',
        dependsOn: [],
        kind: 'caption.setSegmentText',
        captionClipId: 'caption-clip-1',
        segmentId: 'seg-1',
        text: 'سلام به جوی',
      },
    });
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.project.captionDocuments['captions-fa']?.segments[0]?.textOverride).toBe(
      'سلام به جوی',
    );
    const timed = compileJoyCodeCaptionOperation({
      project: text.project,
      operation: {
        id: 'timing',
        dependsOn: [],
        kind: 'caption.setSegmentTiming',
        captionClipId: 'caption-clip-1',
        segmentId: 'seg-1',
        startUs: 100_000,
        endUs: 1_500_000,
      },
    });
    expect(timed.ok).toBe(true);
  });

  it('applies an RTL template only to the selected clip and keeps its other style settings', () => {
    const composition = INITIAL_EDITOR_PROJECT.compositions.root!;
    const track = composition.tracks[0]!;
    const clip = track.clips[0]!;
    if (clip.kind !== 'caption') throw new Error('Expected the caption fixture');
    const target = {
      ...clip,
      style: { ...IDENTITY_CAPTION_CLIP_STYLE, templateId: 'joy-clean', opacity: 0.75 },
    };
    const neighbor = { ...clip, id: 'caption-neighbor', startUs: 7_000_000 };
    const project = {
      ...INITIAL_EDITOR_PROJECT,
      compositions: {
        root: { ...composition, tracks: [{ ...track, clips: [target, neighbor] }] },
      },
    };
    const styled = compileJoyCodeCaptionOperation({
      project,
      operation: {
        id: 'style',
        dependsOn: [],
        kind: 'caption.setTemplate',
        captionClipId: target.id,
        templateId: 'joy-rtl-classic',
      },
    });
    expect(styled.ok).toBe(true);
    if (!styled.ok) return;
    expect(styled.affectedIds).toEqual([target.id]);
    expect(styled.project.captionDocuments).toEqual(project.captionDocuments);
    expect(styled.project.compositions.root?.tracks[0]?.clips).toEqual([
      { ...target, style: { ...target.style, templateId: 'joy-rtl-classic' } },
      neighbor,
    ]);
  });

  it('toggles burn-in without timestamps and rejects missing/unknown data', () => {
    const enabled = compileJoyCodeCaptionOperation({
      project: INITIAL_EDITOR_PROJECT,
      operation: { id: 'burn', dependsOn: [], kind: 'caption.setBurnIn', enabled: true },
    });
    expect(enabled.ok).toBe(true);
    if (enabled.ok) expect(enabled.project.pluginData['joy.captions.burnIn']).toBe(true);
    const missing = compileJoyCodeCaptionOperation({
      project: INITIAL_EDITOR_PROJECT,
      operation: {
        id: 'missing',
        dependsOn: [],
        kind: 'caption.setSegmentText',
        captionClipId: 'nope',
        segmentId: 'seg-1',
        text: 'x',
      },
    });
    expect(missing.ok).toBe(false);
    const unknownTemplate = compileJoyCodeCaptionOperation({
      project: INITIAL_EDITOR_PROJECT,
      operation: {
        id: 'unknown',
        dependsOn: [],
        kind: 'caption.setTemplate',
        captionClipId: 'caption-clip-1',
        templateId: 'custom',
      },
    });
    expect(unknownTemplate.ok).toBe(false);
  });
});
