import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MaskInspector } from './MaskInspector.js';
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
});
