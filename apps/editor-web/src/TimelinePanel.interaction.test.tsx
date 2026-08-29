import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { ContextMenu } from './ContextMenu.js';
import { TimelineContextMenu } from './TimelineContextMenu.js';
import { TimelinePanel } from './TimelinePanel.js';
import { readTimelineElementKindMap } from './timeline-element-kind.js';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';

describe('TimelinePanel clip interaction semantics', () => {
  it('exposes keyboard selection and trim controls plus stable track hooks', () => {
    const markup = renderToStaticMarkup(
      <TimelinePanel
        project={buildReferenceSpikeProject()}
        playheadUs={0}
        playing={false}
        selectedIds={[]}
        viewport={{ originUs: 0, pixelsPerSecond: 20 }}
        onViewportChange={() => undefined}
        autoFit={false}
        onAutoFitChange={() => undefined}
        onTogglePlayback={() => undefined}
        onSeek={() => undefined}
        onToggleSelection={() => undefined}
        onClearSelection={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    expect(markup).toContain('data-track-id=');
    expect(markup).toContain('data-clip-id=');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-roledescription="timeline track"');
    expect(markup).toContain('aria-roledescription="timeline clip"');
    expect(markup).toContain('aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown');
    expect(markup).toContain('data-trim-edge="start"');
    expect(markup).toContain('data-trim-edge="end"');
    expect(markup).toContain(
      'aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"',
    );
    expect(markup).toContain('>V1</span>');
    expect(markup).toContain('>V2</span>');
    expect(markup).toContain('>track-1</span>');
  });

  it('renders an explicit Back control while drilling into a merged composition', () => {
    const base = buildReferenceSpikeProject();
    const root = base.compositions.root!;
    const child = {
      ...root,
      id: 'compound-1',
      name: 'Merged intro',
      durationUs: 20_000_000,
      tracks: [
        {
          ...root.tracks[0]!,
          clips: root.tracks[0]!.clips.slice(0, 2).map((clip) => ({
            ...clip,
            startUs: clip.startUs,
          })),
        },
      ],
    };
    const project = {
      ...base,
      compositions: {
        ...base.compositions,
        root: {
          ...root,
          tracks: [
            {
              ...root.tracks[0]!,
              clips: [
                {
                  kind: 'composition' as const,
                  id: 'compound-clip',
                  startUs: 0,
                  durationUs: 20_000_000,
                  compositionId: 'compound-1',
                  childOffsetUs: 0,
                },
                root.tracks[0]!.clips[2]!,
              ],
            },
            root.tracks[1]!,
          ],
        },
        'compound-1': child,
      },
    };
    const markup = renderToStaticMarkup(
      <TimelinePanel
        project={project}
        activeCompositionId="compound-1"
        playheadUs={0}
        playing={false}
        selectedIds={[]}
        viewport={{ originUs: 0, pixelsPerSecond: 20 }}
        onViewportChange={() => undefined}
        autoFit={false}
        onAutoFitChange={() => undefined}
        onTogglePlayback={() => undefined}
        onSeek={() => undefined}
        onToggleSelection={() => undefined}
        onClearSelection={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    expect(markup).toContain('Back to parent timeline');
    expect(markup).toContain('Merged intro');
  });

  it('renders merge and open-compound actions after their separator instead of dropping them', () => {
    const markup = renderToStaticMarkup(
      <ContextMenu
        x={0}
        y={0}
        onClose={() => undefined}
        items={[
          { label: '', action: () => undefined, dividerBefore: true },
          { label: 'Merge 2 selected clips', action: () => undefined },
          { label: 'Open merged timeline', action: () => undefined },
        ]}
      />,
    );

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('Merge 2 selected clips');
    expect(markup).toContain('Open merged timeline');
    expect(markup).toContain('role="menuitem"');
  });

  it('renders timeline actions in the anchored context drawer with their shortcuts', () => {
    const markup = renderToStaticMarkup(
      <TimelineContextMenu
        menu={{
          x: 240,
          y: 180,
          items: [
            { label: 'Split at playhead', shortcut: 'S', action: () => undefined },
            { label: '', action: () => undefined, dividerBefore: true },
            { label: 'Ripple delete', shortcut: 'Delete', action: () => undefined },
          ],
        }}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain('timeline-context-menu');
    expect(markup).toContain('timeline-context-backdrop');
    expect(markup).toContain('Split at playhead');
    expect(markup).toContain('Ripple delete');
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('data-menu-index="2"');
  });

  it('renders Video and the six requested element identities in the Classic timeline', () => {
    const { timeline, visual } = buildTimelineElementsShowcase();
    const markup = renderToStaticMarkup(
      <TimelinePanel
        project={timeline}
        elementKinds={readTimelineElementKindMap(visual)}
        playheadUs={7_000_000}
        playing={false}
        selectedIds={['showcase-adjust']}
        trackFlags={timeline.compositions.root!.tracks.map((track, order) => ({
          id: track.id,
          heightPx: 20,
          locked: false,
          visible: true,
          solo: false,
          order,
        }))}
        viewport={{ originUs: 0, pixelsPerSecond: 20 }}
        onViewportChange={() => undefined}
        autoFit={false}
        onAutoFitChange={() => undefined}
        onTogglePlayback={() => undefined}
        onSeek={() => undefined}
        onToggleSelection={() => undefined}
        onClearSelection={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    for (const kind of [
      'video',
      'text',
      'effect',
      'filter',
      'adjust',
      'overlay',
      'scene3d',
      'audio',
    ]) {
      expect(markup).toContain(`data-element-kind="${kind}"`);
    }
    expect(markup).toContain('timeline-clip--adjust');
    expect(markup).not.toContain('data-element-kind="sticker"');
  });
});
