// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  it('exposes transcription failures beside the actions that are affected', () => {
    const markup = renderToStaticMarkup(
      <CaptionsPanel
        project={INITIAL_EDITOR_PROJECT}
        playheadUs={0}
        onSeek={() => undefined}
        onDispatch={() => undefined}
        onTranscribe={async () => undefined}
        transcriptionError="Select an audio or video clip to transcribe."
        onProjectChange={() => undefined}
      />,
    );

    expect(markup).toContain(
      'Transcription unavailable: Select an audio or video clip to transcribe.',
    );
    expect(markup).toContain('class="caption-transcription-status" role="status"');
  });

  it('describes the unavailable status from both generate actions', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CaptionsPanel
          project={INITIAL_EDITOR_PROJECT}
          playheadUs={0}
          onSeek={() => undefined}
          onDispatch={() => undefined}
          onTranscribe={async () => undefined}
          transcriptionError="Select an audio or video clip to transcribe."
          onProjectChange={() => undefined}
        />,
      );
    });

    const generateTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent === 'Generate',
    );
    await act(async () => {
      generateTab?.click();
    });
    const actions = [
      ...container.querySelectorAll<HTMLButtonElement>('.caption-generate-actions button'),
    ];
    expect(actions).toHaveLength(2);
    const describedByIds = actions.map((button) => button.getAttribute('aria-describedby'));
    expect(describedByIds.every((id) => id !== null)).toBe(true);
    expect(new Set(describedByIds).size).toBe(1);
    const description = [...container.querySelectorAll<HTMLElement>('[id]')].find(
      (element) => element.id === describedByIds[0],
    );
    expect(description?.textContent).toContain('Transcription unavailable:');

    await act(async () => root.unmount());
    container.remove();
  });
});
