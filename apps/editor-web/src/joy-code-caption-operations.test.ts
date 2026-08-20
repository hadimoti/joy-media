import { describe, expect, it } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { compileJoyCodeCaptionOperation } from './joy-code-caption-operations.js';

describe('Joy Code caption operations', () => {
  it('updates segment text/timing and applies a curated RTL template', () => {
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
    const styled = compileJoyCodeCaptionOperation({
      project: text.project,
      operation: {
        id: 'style',
        dependsOn: [],
        kind: 'caption.setTemplate',
        captionClipId: 'caption-clip-1',
        templateId: 'joy-rtl-classic',
      },
    });
    expect(styled.ok).toBe(true);
    if (styled.ok)
      expect(styled.project.captionDocuments['captions-fa']?.styleRef).toBe('joy-rtl-classic');
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
