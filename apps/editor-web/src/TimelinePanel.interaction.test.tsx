import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { TimelinePanel } from './TimelinePanel.js';

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
    expect(markup).toContain('data-trim-edge="start"');
    expect(markup).toContain('data-trim-edge="end"');
    expect(markup).toContain(
      'aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"',
    );
  });
});
