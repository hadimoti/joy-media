import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CaptionsPanel } from './CaptionsPanel.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

describe('CaptionsPanel empty state', () => {
  it('offers an accessible caption-track action when no slot exists', () => {
    const root = INITIAL_EDITOR_PROJECT.compositions.root!;
    const project = {
      ...INITIAL_EDITOR_PROJECT,
      captionDocuments: {},
      compositions: {
        ...INITIAL_EDITOR_PROJECT.compositions,
        root: { ...root, tracks: root.tracks.filter((track) => track.kind !== 'caption') },
      },
    };
    const markup = renderToStaticMarkup(
      <CaptionsPanel
        project={project}
        playheadUs={0}
        onSeek={() => undefined}
        onDispatch={() => undefined}
        onTranscribe={async () => undefined}
        transcriptionError={undefined}
        onProjectChange={() => undefined}
      />,
    );

    expect(markup).toContain('Add caption track');
    expect(markup).toContain('aria-label="Add caption track"');
  });

  it('renders the editable display override with accessible edit and revert controls', () => {
    const document = INITIAL_EDITOR_PROJECT.captionDocuments['captions-fa']!;
    const first = document.segments[0]!;
    const project = {
      ...INITIAL_EDITOR_PROJECT,
      captionDocuments: {
        ...INITIAL_EDITOR_PROJECT.captionDocuments,
        'captions-fa': {
          ...document,
          segments: [{ ...first, textOverride: 'Edited caption' }, ...document.segments.slice(1)],
        },
      },
    };
    const markup = renderToStaticMarkup(
      <CaptionsPanel
        project={project}
        playheadUs={0}
        onSeek={() => undefined}
        onDispatch={() => undefined}
        onTranscribe={async () => undefined}
        transcriptionError={undefined}
        onProjectChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Caption text seg-1"');
    expect(markup).toContain('value="Edited caption"');
    expect(markup).toContain('title="Source: Welcome to JOY"');
    expect(markup).toContain('aria-label="Revert caption seg-1 to source text"');
    expect(markup).toContain('aria-label="Delete caption seg-1"');
  });
});
