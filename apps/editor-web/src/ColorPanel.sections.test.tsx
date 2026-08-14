import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createIdentityColorGrade } from '@joy-media/project-schema';
import { HslSection, LooksSection, ScopeCanvas } from './ColorPanel.js';

const stateFor = () => 'none' as const;
const ignore = () => undefined;

describe('Color workspace sections', () => {
  it('exposes every HSL dimension as an accessible, keyframeable property', () => {
    const markup = renderToStaticMarkup(
      <HslSection
        draft={createIdentityColorGrade()}
        onChange={ignore}
        onCommit={ignore}
        animationStateFor={stateFor}
        onToggleAnimation={ignore}
        canAnimate={true}
      />,
    );

    for (const property of [
      'Red Hue',
      'Red Range',
      'Red Softness',
      'Red Saturation',
      'Red Luminance',
    ]) {
      expect(markup).toContain(`data-property-row="${property}"`);
      expect(markup).toContain(`Add ${property} keyframe at playhead`);
    }
    expect(markup).toContain('Reset hue bands');
  });

  it('uses the shared animation shell for LUT intensity and identifies custom LUTs', () => {
    const grade = {
      ...createIdentityColorGrade(),
      lut: { assetId: 'lut-1', contentHash: 'sha256-demo', intensity: 0.75 },
    } as const;
    const markup = renderToStaticMarkup(
      <LooksSection
        draft={grade}
        onChange={ignore}
        onCommit={ignore}
        animationStateFor={stateFor}
        onToggleReference={ignore}
        onToggleAnimation={ignore}
        canAnimate={true}
        customLutName="Studio look.cube"
        referenceAvailable={true}
      />,
    );

    expect(markup).toContain('Studio look.cube');
    expect(markup).toContain('data-property-row="LUT intensity"');
    expect(markup).toContain('Add LUT intensity keyframe at playhead');
  });

  it('names the real scope source and exposes IRE guides only where meaningful', () => {
    const waveform = renderToStaticMarkup(<ScopeCanvas scope="waveform" />);
    const vectorscope = renderToStaticMarkup(<ScopeCanvas scope="vectorscope" />);

    expect(waveform).toContain('Waveform scope analyzing final Program output');
    expect(waveform).toContain('100');
    expect(waveform).toContain('0 IRE');
    expect(vectorscope).toContain('Vectorscope scope analyzing final Program output');
    expect(vectorscope).not.toContain('0 IRE');
  });
});
