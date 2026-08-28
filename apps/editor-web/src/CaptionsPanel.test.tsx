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
    expect(markup).toContain('class="caption-text-input" dir="rtl"');
    expect(markup).toContain('value="سلام به جوی"');
    expect(markup).toContain('Source: <bdi dir="rtl">سلام به جوی</bdi>');
    expect(markup).toContain(
      'Transcription unavailable: Select an audio or video clip to transcribe.',
    );
    const describedByIds = [...markup.matchAll(/aria-describedby="([^"]+)"/gu)].map(([, id]) => id);
    expect(describedByIds).toHaveLength(3);
    expect(new Set(describedByIds).size).toBe(1);
    expect(markup).toContain(`id="${describedByIds[0]}"`);
    expect(markup).toContain('class="caption-transcription-status" role="status"');
    expect(markup).toContain('placeholder="Write caption…"');
    expect(markup).not.toContain('seg-1');
    expect(markup).not.toContain('New caption');
    expect(markup).not.toContain('Caption at ');
  });

  it('removes the unavailable status when a transcription source is ready', () => {
    const markup = renderToStaticMarkup(
      <CaptionsPanel
        project={INITIAL_EDITOR_PROJECT}
        playheadUs={1_000_000}
        onSeek={() => undefined}
        onDispatch={() => undefined}
        onTranscribe={async () => undefined}
        transcriptionAvailability={{
          state: 'ready',
          source: {
            assetId: 'asset-intro',
            candidateKey: 'clip-intro',
            transport: 'reference',
            sourceStartUs: 0,
            sourceDurationUs: 2_000_000,
            playbackRate: 1,
            timelineStartUs: 0,
            timelineDurationUs: 2_000_000,
          },
        }}
        transcriptionError={undefined}
        onProjectChange={() => undefined}
      />,
    );

    expect(markup).not.toContain('caption-transcription-status');
    expect(markup).not.toContain('aria-describedby');
    expect(markup).not.toContain('disabled=""');
  });
});
