import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThreeDStudioCanvas } from './ThreeDStudioCanvas.js';
import { emptyScene3D } from '@joy-media/scene3d-core';

describe('3D canvas shell', () => {
  it('renders a dedicated viewport boundary for the scene document', () => {
    const markup = renderToStaticMarkup(
      <ThreeDStudioCanvas document={emptyScene3D('scene-1')} onSelect={() => undefined} />,
    );
    expect(markup).toContain('aria-label="3D viewport"');
  });
});
