import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MaskInspector, maskRuntimeStatus } from './MaskInspector.js';
import { defaultMaskSettings } from './masking.js';

describe('MaskInspector', () => {
  it('renders a compact professional video masking surface in the Inspector', () => {
    const markup = renderToStaticMarkup(
      <MaskInspector
        projectId="project-1"
        projectTitle="Masking"
        target={{
          targetId: 'clip-1',
          clipId: 'clip-1',
          assetId: 'video-1',
          kind: 'video',
          durationUs: 5_000_000,
        }}
        settings={defaultMaskSettings('video')}
        onChange={() => undefined}
        onApplyResult={async () => 'mask-result'}
        onClear={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Mask controls"');
    expect(markup).toContain('SAM 3.1');
    expect(markup).toContain('SAM 2.1 + Grounding DINO');
    expect(markup).toContain('BiRefNet');
    expect(markup).toContain('aria-label="Subject selection mode"');
    expect(markup).toContain('aria-label="Tracking direction"');
    expect(markup).toContain('Create Mask');
    expect(markup).toContain('Remove BG');
  });

  it('distinguishes a live photo Worker from video tracking and stale pairings', () => {
    const photoWorker = {
      id: 'worker-photo',
      paired: true,
      revoked: false,
      capabilities: ['mask.image'],
      localAssetIds: ['photo-1'],
      lastSeenAt: 1_000,
    } as const;

    expect(
      maskRuntimeStatus({ kind: 'image', assetId: 'photo-1' }, [photoWorker], 2_000),
    ).toMatchObject({
      state: 'ready',
      label: 'Photo Worker ready',
    });
    expect(
      maskRuntimeStatus({ kind: 'video', assetId: 'video-1' }, [photoWorker], 2_000),
    ).toMatchObject({
      state: 'model-missing',
      label: 'Photo masks ready · add SAM 2',
    });
    expect(
      maskRuntimeStatus({ kind: 'image', assetId: 'photo-1' }, [photoWorker], 40_000),
    ).toMatchObject({
      state: 'offline',
      label: 'Local Worker offline',
    });
  });
});
