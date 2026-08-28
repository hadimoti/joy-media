import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { CaptionsPanel, captionTextTransaction } from './CaptionsPanel.js';

describe('CaptionsPanel text editing', () => {
  it('builds one explicit history transaction for an edited caption', () => {
    expect(
      captionTextTransaction({
        documentId: 'doc-1',
        segmentId: 'segment-1',
        sourceText: 'Source words',
        draft: 'Corrected words',
      }),
    ).toEqual({
      label: 'Edit caption text',
      commands: [
        {
          type: 'caption.setSegmentText',
          payload: {
            documentId: 'doc-1',
            segmentId: 'segment-1',
            textOverride: 'Corrected words',
          },
        },
      ],
    });
  });

  it('turns an edit matching the immutable source back into a revert command', () => {
    expect(
      captionTextTransaction({
        documentId: 'doc-1',
        segmentId: 'segment-1',
        sourceText: 'Source words',
        currentOverride: 'Corrected words',
        draft: 'Source words',
      }),
    ).toMatchObject({
      label: 'Revert caption text',
      commands: [{ payload: { textOverride: undefined } }],
    });
    expect(
      captionTextTransaction({
        documentId: 'doc-1',
        segmentId: 'segment-1',
        sourceText: 'Source words',
        draft: 'Source words',
      }),
    ).toBeUndefined();
  });

  it('renders editable display text while keeping source words visible', () => {
    const markup = renderToStaticMarkup(
      <CaptionsPanel
        project={INITIAL_EDITOR_PROJECT}
        playheadUs={1_000_000}
        onSeek={() => undefined}
        onDispatch={() => undefined}
        onTranscribe={async () => undefined}
        transcriptionAvailability={{
          state: 'unavailable',
          reason: 'Select an audio or video clip to transcribe.',
        }}
        transcriptionError={undefined}
        onProjectChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Edit caption 1 at 0.00s"');
    expect(markup).toContain('value="سلام به جوی"');
    expect(markup).toContain('Source: سلام به جوی');
    expect(markup).toContain('Select an audio or video clip to transcribe');
    expect(markup).toContain('placeholder="Write caption…"');
    expect(markup).not.toContain('seg-1');
    expect(markup).not.toContain('New caption');
    expect(markup).not.toContain('Caption at ');
  });
});
