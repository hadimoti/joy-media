import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBlankScene } from '@joy-media/motion-core';
import {
  motionStudioAssetUrl,
  MotionStudioCanvas,
  svgContentToDataUrl,
} from './MotionStudioCanvas.js';
import { createImageLayer, createSvgLayer, createVideoLayer } from './state/layerFactory.js';

function noop() {}

describe('MotionStudioCanvas media surface', () => {
  it('routes real image and video layers through the cloud asset content endpoint', () => {
    expect(motionStudioAssetUrl('asset real/video 1')).toBe(
      '/v1/library/cloud-assets/asset%20real%2Fvideo%201/content',
    );
    expect(motionStudioAssetUrl('asset real/video 1')).not.toContain('/api/assets/');
  });

  it('renders image, video, and SVG layers without replacing SVG content with a placeholder', () => {
    const image = createImageLayer('asset-image-1', 'Imported Image');
    const video = createVideoLayer('asset-video-1', 'Imported Video');
    const svg = createSvgLayer('<svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>', 'Logo');
    const document = { ...createBlankScene('Canvas'), layers: [image, video, svg] };

    const markup = renderToStaticMarkup(
      <MotionStudioCanvas
        document={document}
        selectedLayerIds={[]}
        onSelectLayer={noop}
        onSelectLayers={noop}
        onToggleLayerSelection={noop}
        onClearSelection={noop}
        onSetLayerTransform={noop}
        onDispatch={noop}
        onBeginTransaction={noop}
        onUpdateTransaction={noop}
        onCommitTransaction={noop}
        onCancelTransaction={noop}
        onDuplicateSelected={noop}
        onDeleteSelected={noop}
        onBringToFront={noop}
        onSendToBack={noop}
        onGroupSelected={noop}
        onUngroupSelected={noop}
        onAddTextLayer={noop}
        onAddRectangleLayer={noop}
        onAddEllipseLayer={noop}
        onAddImageLayer={noop}
        onAddVideoLayer={noop}
      />,
    );

    expect(markup).toContain('/v1/library/cloud-assets/asset-image-1/content');
    expect(markup).toContain('/v1/library/cloud-assets/asset-video-1/content');
    expect(markup).toContain('<video');
    expect(markup).toContain('playsInline');
    expect(markup).not.toContain('src="/v1/library/cloud-assets/asset-video-1/content" alt=');
    expect(markup).toContain(svgContentToDataUrl(svg.svgContent));
  });
});
