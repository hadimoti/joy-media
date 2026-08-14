import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { registerBuiltins, effectRegistry } from '@joy-media/visual-effects';
import { InspectorPanel } from './InspectorPanel.js';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';

if (!effectRegistry.hasEffect('brightness-contrast')) registerBuiltins();

describe('Inspector Adjust layer', () => {
  it('shows parent routing and keyframeable adjustments as a dedicated layer inspector', () => {
    const { visual } = buildTimelineElementsShowcase();
    const object = visual.visualObjects['showcase-adjust-controller']!;
    const markup = renderToStaticMarkup(
      <InspectorPanel
        object={object}
        selectedClipId="showcase-adjust"
        selectedKind="Adjust"
        selectedName="Adjust"
        allObjects={visual.visualObjects}
        playheadUs={7_000_000}
        project={visual}
        adjustmentLayer={{
          targetClipId: 'showcase-product',
          targets: [
            { clipId: 'showcase-product', label: 'Product', kind: 'video' },
            { clipId: 'showcase-overlay', label: 'Overlay', kind: 'picture' },
          ],
        }}
        onAdjustmentTargetChange={() => undefined}
        onSetStatic={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Adjustment parent media"');
    expect(markup).toContain('Product · video');
    expect(markup).toContain('Overlay · picture');
    expect(markup).toContain('Adjust → showcase-product');
    expect(markup).toContain('data-property-row="Brightness"');
    expect(markup).toContain('data-property-row="Contrast"');
    expect(markup).toContain('data-property-row="Amount"');
    expect(markup).toContain('Add Brightness keyframe at playhead');
    expect(markup).not.toContain('aria-label="Audio"');
    expect(markup).not.toContain('aria-label="Speed"');
  });
});
