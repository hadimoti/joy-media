import { buildHistoricalSchemaProjects } from '@joy-media/test-fixtures';
import { projectV3ToDesktopVisual, type JoyProjectV1 } from '@joy-media/project-schema';
import type { RenderFrameIR } from '@joy-media/render-ir';
import { buildRenderFrameIR } from '@joy-media/visual-object-renderer';
import { describe, expect, it } from 'vitest';
import type { HtmlSceneProjectContext } from './html-scene-surfaces.js';
import { applyP0DesktopLayers } from './p0-desktop-layers.js';

function fixture(options: {
  titleTrack: number;
  videoTrack: number;
  enabled?: boolean;
  timeUs?: number;
}) {
  const source = buildHistoricalSchemaProjects().v3;
  const base = projectV3ToDesktopVisual(source);
  const baseWithoutDeck = { ...base };
  delete baseWithoutDeck.timelineTrackDeck;
  const titleId = 'title-object';
  const videoClipId = 'video-clip';
  const root = base.compositions.root!;
  const trackTemplate = root.tracks[0]!;
  const tracks = Array.from({ length: 3 }, (_, index) => ({
    ...trackTemplate,
    id: `track-${index}`,
    order: index,
    enabled: index !== options.titleTrack || options.enabled !== false,
  }));
  const visual: JoyProjectV1 = {
    ...baseWithoutDeck,
    compositions: {
      ...base.compositions,
      root: { ...root, tracks },
    },
    visualObjects: {
      ...base.visualObjects,
      [titleId]: {
        id: titleId,
        kind: 'html-scene',
        scenePackageId: 'joy.p0.title',
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    },
    universalTimeline: {
      schemaVersion: 1,
      items: [
        {
          id: 'title-clip',
          compositionId: 'root',
          trackId: `track-${options.titleTrack}`,
          elementKind: 'html-scene',
          startUs: 100,
          durationUs: 100,
          source: { kind: 'object', id: titleId },
          withinTrackOrder: 0,
        },
        {
          id: videoClipId,
          compositionId: 'root',
          trackId: `track-${options.videoTrack}`,
          elementKind: 'video',
          startUs: 0,
          durationUs: 1_000,
          source: { kind: 'asset', id: 'asset-video' },
          withinTrackOrder: 0,
        },
      ],
    },
  };
  const frame = {
    version: 1,
    compositionId: 'root',
    timeUs: options.timeUs ?? 150,
    viewport: { width: 320, height: 180, dpr: 1 },
    background: { r: 0, g: 0, b: 0, a: 1 },
    nodes: [
      {
        kind: 'video-frame',
        id: titleId,
        zIndex: 0,
        opacity: 1,
        transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
        width: 1080,
        height: 1920,
        sourceTimeUs: 0,
        color: { r: 0, g: 0, b: 0, a: 0 },
      },
      {
        kind: 'video-frame',
        id: videoClipId,
        zIndex: 0,
        opacity: 1,
        transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
        width: 320,
        height: 180,
        sourceTimeUs: 0,
        color: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
  } as unknown as RenderFrameIR;
  const context = { visual, timeline: {} } as unknown as HtmlSceneProjectContext;
  return { context, frame, titleId, videoClipId };
}

describe('applyP0DesktopLayers', () => {
  it('orders title and video nodes by enabled timeline track order in both directions', () => {
    const titleBelowVideo = fixture({ titleTrack: 0, videoTrack: 2 });
    const below = applyP0DesktopLayers(titleBelowVideo.frame, titleBelowVideo.context, 150);
    expect(below.nodes.find((node) => node.id === titleBelowVideo.titleId)?.zIndex).toBeLessThan(
      below.nodes.find((node) => node.id === titleBelowVideo.videoClipId)!.zIndex,
    );

    const videoBelowTitle = fixture({ titleTrack: 2, videoTrack: 0 });
    const above = applyP0DesktopLayers(videoBelowTitle.frame, videoBelowTitle.context, 150);
    expect(
      above.nodes.find((node) => node.id === videoBelowTitle.videoClipId)?.zIndex,
    ).toBeLessThan(above.nodes.find((node) => node.id === videoBelowTitle.titleId)!.zIndex);
    expect(titleBelowVideo.frame.nodes[0]?.zIndex).toBe(0);
  });

  it('omits disabled and half-open inactive P0 title clips', () => {
    const disabled = fixture({ titleTrack: 0, videoTrack: 2, enabled: false });
    expect(applyP0DesktopLayers(disabled.frame, disabled.context, 150).nodes).toHaveLength(1);

    const atStart = fixture({ titleTrack: 0, videoTrack: 2, timeUs: 100 });
    expect(applyP0DesktopLayers(atStart.frame, atStart.context, 100).nodes).toHaveLength(2);
    expect(applyP0DesktopLayers(atStart.frame, atStart.context, 200).nodes).toHaveLength(1);
  });

  it('uses composition dimensions for P0 titles and keeps generic HTML-scene dimensions unchanged', () => {
    const { context, titleId } = fixture({ titleTrack: 0, videoTrack: 2 });
    const p0Object = context.visual.visualObjects[titleId]!;
    const genericObject = { ...p0Object, id: 'generic-scene', scenePackageId: 'vendor.scene' };
    const frame = buildRenderFrameIR('root', 0, 320, 180, [
      { object: p0Object, transform: p0Object.transform },
      { object: genericObject, transform: genericObject.transform },
    ]);

    expect(frame.nodes.find((node) => node.id === titleId)).toMatchObject({
      width: 320,
      height: 180,
    });
    expect(frame.nodes.find((node) => node.id === 'generic-scene')).toMatchObject({
      width: 1080,
      height: 1920,
    });
  });
});
