import { useRef, useState, type ReactElement } from 'react';
import type {
  CaptionClipV1,
  CaptionDocumentV1,
  JoyProjectV1,
  TrackV1,
} from '@joy-media/project-schema';
import {
  captionSlots,
  DEFAULT_CAPTION_TEMPLATE_ID,
  formatSrt,
  formatWebVtt,
  JOY_CAPTION_TEMPLATES,
  parseSrt,
  parseWebVtt,
  resolveCaptionDirection,
  searchCaptionSegments,
  segmentDisplayText,
  segmentMinConfidence,
  segmentSourceText,
  segmentTimelineRange,
} from '@joy-media/captions-core';
import type { CaptionSlot } from '@joy-media/captions-core';
import { readCaptionBurnIn, withCaptionBurnIn } from './caption-burn-in.js';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import {
  AutoCaptionIcon,
  BurnInIcon,
  LanguageIcon,
  PlusIcon,
  TrashIcon,
  UndoIcon,
  PngMaskIcon,
} from './icons.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { downloadBrowserTextFile } from './browser-text-download.js';

const TEMPLATE_ICONS: Readonly<
  Record<string, { readonly Icon: () => ReactElement; readonly label: string }>
> = {
  'joy-clean': {
    Icon: () => <PngMaskIcon src="/assets/24_Text.png" size={14} />,
    label: 'JOY Clean',
  },
  'joy-karaoke-pop': {
    Icon: () => <PngMaskIcon src="/assets/24_creative.png" size={14} />,
    label: 'JOY Karaoke Pop',
  },
  'joy-rtl-classic': {
    Icon: () => <PngMaskIcon src="/assets/24_UI.png" size={14} />,
    label: 'JOY RTL Classic',
  },
};

function createCaptionSlotProject(project: JoyProjectV1): JoyProjectV1 {
  const compositionId = project.rootCompositionId;
  const composition = project.compositions[compositionId];
  if (composition === undefined) return project;

  const token =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const documentId = `captions-${token}`;
  const document: CaptionDocumentV1 = {
    id: documentId,
    language: 'en-US',
    direction: 'auto',
    speakers: [],
    words: {},
    segments: [],
  };
  const clip: CaptionClipV1 = {
    id: `caption-clip-${token}`,
    kind: 'caption',
    startUs: 0,
    durationUs: Math.max(1_000_000, composition.durationUs),
    captionDocumentId: documentId,
  };
  const existingTrack = composition.tracks.find(
    (track) => track.kind === 'caption' && track.enabled && !track.locked,
  );
  const nextTrack: TrackV1 =
    existingTrack !== undefined
      ? { ...existingTrack, clips: [...existingTrack.clips, clip] }
      : {
          id: `caption-track-${token}`,
          kind: 'caption',
          name: 'Captions',
          order: composition.tracks.reduce((max, track) => Math.max(max, track.order), -1) + 1,
          enabled: true,
          locked: false,
          clips: [clip],
        };
  const tracks =
    existingTrack === undefined
      ? [...composition.tracks, nextTrack]
      : composition.tracks.map((track) => (track.id === existingTrack.id ? nextTrack : track));

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    captionDocuments: { ...project.captionDocuments, [documentId]: document },
    compositions: {
      ...project.compositions,
      [compositionId]: { ...composition, tracks },
    },
  };
}

/**
 * Transcript-first caption editing (WP-03.2/03.3). Every durable change goes
 * through the shared v1 command history; text edits write display overrides
 * only, so transcription source tokens stay recoverable. Styling is applied by
 * template reference, previewed live from the same templated layout the
 * renderer consumes.
 */
export function CaptionsPanel({
  project,
  playheadUs,
  onSeek,
  onDispatch,
  onTranscribe,
  transcriptionError,
  onProjectChange,
}: {
  readonly project: JoyProjectV1;
  readonly playheadUs: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
  readonly onTranscribe: (documentId: string, language: 'fa-IR' | 'en-US') => Promise<void>;
  readonly transcriptionError: string | undefined;
  readonly onProjectChange: (next: JoyProjectV1) => void;
}) {
  const [query, setQuery] = useState('');
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) throw new Error('captions root composition is unavailable');
  const slots = captionSlots(composition, project.captionDocuments);
  const burnIn = readCaptionBurnIn(project);
  // §3c: no caption tracks is an idle body, not a different panel.
  const idle = slots.length === 0;

  return (
    <PanelShell
      title="Captions"
      iconUrl={panelTabIconUrl('captions')}
      className="captions-panel"
      search={{ value: query, onChange: setQuery, placeholder: 'Search transcription…' }}
      // Keep the empty-state CTA interactive; PanelShell's inactive body uses
      // pointer-events:none, which would make the only recovery action dead.
      inactive={false}
      {...(idle
        ? { note: 'Add a caption track to start transcription.' }
        : transcriptionError !== undefined
          ? { note: `${transcriptionError} You can continue editing captions manually.` }
          : {})}
      actions={
        <button
          type="button"
          className="icon-button"
          aria-pressed={burnIn}
          aria-label={burnIn ? 'Disable caption burn-in' : 'Enable caption burn-in'}
          title={burnIn ? 'Burn-in on' : 'Burn-in off'}
          data-guide={burnIn ? 'Burn-in on' : 'Burn-in off'}
          disabled={idle}
          onClick={() => onProjectChange(withCaptionBurnIn(project, !burnIn))}
        >
          <BurnInIcon />
        </button>
      }
    >
      {idle ? (
        <div className="caption-empty-state">
          <p className="empty-hint">
            Add a caption track to begin editing, importing, or transcribing captions.
          </p>
          <button
            type="button"
            className="icon-button icon-button-labeled"
            aria-label="Add caption track"
            title="Add caption track"
            onClick={() => onProjectChange(createCaptionSlotProject(project))}
          >
            <PlusIcon />
            Add caption track
          </button>
        </div>
      ) : (
        slots.map((slot) => (
          <CaptionSlotEditor
            key={`${slot.trackId}:${slot.clip.id}`}
            slot={slot}
            query={query}
            playheadUs={playheadUs}
            onSeek={onSeek}
            onDispatch={onDispatch}
            onTranscribe={onTranscribe}
          />
        ))
      )}
    </PanelShell>
  );
}

function CaptionSlotEditor({
  slot,
  query,
  playheadUs,
  onSeek,
  onDispatch,
  onTranscribe,
}: {
  readonly slot: CaptionSlot;
  readonly query: string;
  readonly playheadUs: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
  readonly onTranscribe: (documentId: string, language: 'fa-IR' | 'en-US') => Promise<void>;
}) {
  const { clip, document } = slot;
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [importIssues, setImportIssues] = useState(0);
  const [transcribingLanguage, setTranscribingLanguage] = useState<'fa-IR' | 'en-US'>();
  const direction = resolveCaptionDirection(document);
  const matches =
    query.trim().length === 0
      ? undefined
      : new Set(searchCaptionSegments(document, query).map((match) => match.segment.id));
  const segments = document.segments.filter(
    (segment) => matches === undefined || matches.has(segment.id),
  );
  const addSegment = () => {
    const startUs = Math.max(0, playheadUs - clip.startUs);
    onDispatch({
      label: 'Add caption',
      commands: [
        {
          type: 'caption.addSegment',
          payload: {
            documentId: document.id,
            segment: {
              id: crypto.randomUUID(),
              startUs,
              endUs: startUs + 2_000_000,
              wordIds: [],
              textOverride: 'New caption',
            },
          },
        },
      ],
    });
  };
  const applyTemplate = (styleRef: string) => {
    onDispatch({
      label: 'Apply caption template',
      commands: [{ type: 'caption.setStyle', payload: { documentId: document.id, styleRef } }],
    });
  };
  const importFile = async (file: File) => {
    const text = await file.text();
    const parsed = file.name.toLowerCase().endsWith('.vtt')
      ? parseWebVtt(text, { documentId: document.id, language: document.language })
      : parseSrt(text, { documentId: document.id, language: document.language });
    const imported =
      document.styleRef === undefined
        ? parsed.document
        : { ...parsed.document, styleRef: document.styleRef };
    setImportIssues(parsed.diagnostics.length);
    onDispatch({
      label: `Import ${file.name}`,
      commands: [
        {
          type: 'caption.replaceDocument',
          payload: { documentId: document.id, document: imported },
        },
      ],
    });
  };
  const transcribe = async (language: 'fa-IR' | 'en-US') => {
    if (transcribingLanguage !== undefined) return;
    setTranscribingLanguage(language);
    try {
      await onTranscribe(document.id, language);
    } finally {
      setTranscribingLanguage(undefined);
    }
  };
  return (
    <section aria-label={`Captions ${document.language}`}>
      <header className="captions-slot-header">
        <strong>
          {document.language} · {direction.toUpperCase()}
        </strong>
        <div className="captions-template-icons" role="group" aria-label="Caption template">
          {JOY_CAPTION_TEMPLATES.map((template) => {
            const meta = TEMPLATE_ICONS[template.id];
            const Icon = meta?.Icon ?? (() => <PngMaskIcon src="/assets/24_Text.png" size={14} />);
            const active = (document.styleRef ?? DEFAULT_CAPTION_TEMPLATE_ID) === template.id;
            return (
              <button
                key={template.id}
                type="button"
                className="icon-button"
                aria-pressed={active}
                aria-label={meta?.label ?? template.name}
                data-guide={meta?.label ?? template.name}
                onClick={() => applyTemplate(template.id)}
              >
                <Icon />
              </button>
            );
          })}
        </div>
        <button
          className="icon-button"
          aria-label="Export captions as SRT"
          data-guide="Export SRT"
          onClick={() => downloadBrowserTextFile(`${document.id}.srt`, formatSrt(document))}
        >
          <PngMaskIcon src="/assets/24_output.png" size={14} />
        </button>
        <button
          className="icon-button"
          aria-label="Export captions as WebVTT"
          data-guide="Export VTT"
          onClick={() => downloadBrowserTextFile(`${document.id}.vtt`, formatWebVtt(document))}
        >
          <PngMaskIcon src="/assets/24_output.png" size={14} />
        </button>
        <button
          className="icon-button"
          aria-label="Import captions"
          title="Import SRT/VTT file"
          onClick={() => fileInput.current?.click()}
        >
          <PngMaskIcon src="/assets/24_arrows.png" size={14} />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".srt,.vtt"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file !== undefined) void importFile(file);
          }}
        />
        <button
          className="icon-button"
          aria-label="Add caption"
          title="Add caption at playhead"
          onClick={addSegment}
        >
          <PlusIcon />
        </button>
        <button
          className="icon-button"
          aria-label="Auto caption"
          aria-busy={transcribingLanguage === 'en-US'}
          data-guide="Auto caption"
          disabled={transcribingLanguage !== undefined}
          onClick={() => void transcribe('en-US')}
        >
          <AutoCaptionIcon />
        </button>
        <button
          className="icon-button"
          aria-label="Transcribe Persian"
          aria-busy={transcribingLanguage === 'fa-IR'}
          data-guide="Persian (fa)"
          disabled={transcribingLanguage !== undefined}
          onClick={() => void transcribe('fa-IR')}
        >
          <LanguageIcon label="FA" />
        </button>
        <button
          className="icon-button"
          aria-label="Transcribe English"
          aria-busy={transcribingLanguage === 'en-US'}
          data-guide="English (en)"
          disabled={transcribingLanguage !== undefined}
          onClick={() => void transcribe('en-US')}
        >
          <PngMaskIcon src="/assets/24_Audio.png" size={14} />
        </button>
      </header>
      {transcribingLanguage !== undefined && (
        <p className="caption-transcription-status" role="status">
          Transcribing {transcribingLanguage === 'fa-IR' ? 'Persian' : 'English'}…
        </p>
      )}
      {importIssues > 0 && (
        <p className="caption-warning">On import, {importIssues} bad cue(s) were skipped.</p>
      )}
      {segments.length === 0 && <p>No matching captions found.</p>}
      <ol className="captions-list">
        {segments.map((segment) => {
          const range = segmentTimelineRange(clip, segment);
          const active =
            range !== undefined &&
            playheadUs >= range.startUs &&
            playheadUs < range.startUs + range.durationUs;
          const source = segmentSourceText(document, segment);
          const displayText = segmentDisplayText(document, segment);
          const confidence = segmentMinConfidence(document, segment);
          return (
            <li key={segment.id} className={active ? 'caption-row active' : 'caption-row'}>
              <span
                className="caption-time"
                role="button"
                tabIndex={0}
                aria-label={`Seek to ${(segment.startUs / 1_000_000).toFixed(2)}s`}
                onClick={() => range !== undefined && onSeek(range.startUs)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && range !== undefined) onSeek(range.startUs);
                }}
              >
                {(segment.startUs / 1_000_000).toFixed(2)}s
              </span>
              {confidence !== undefined && (
                <span
                  className="caption-warning"
                  title={`Transcription confidence: ${Math.round(confidence * 100)}%`}
                >
                  {Math.round(confidence * 100)}%
                </span>
              )}
              <input
                type="text"
                className="caption-source"
                aria-label={`Caption text ${segment.id}`}
                title={source.length > 0 ? `Source: ${source}` : 'Manual caption text'}
                value={displayText}
                dir={direction}
                lang={document.language}
                onChange={(event) =>
                  onDispatch({
                    label: 'Edit caption text',
                    commands: [
                      {
                        type: 'caption.setSegmentText',
                        payload: {
                          documentId: document.id,
                          segmentId: segment.id,
                          textOverride: event.currentTarget.value,
                        },
                      },
                    ],
                  })
                }
              />
              {segment.textOverride !== undefined && (
                <button
                  className="icon-button caption-undo-btn"
                  aria-label={`Revert caption ${segment.id} to source text`}
                  title={`Revert to source: ${source}`}
                  onClick={() =>
                    onDispatch({
                      label: 'Revert caption text',
                      commands: [
                        {
                          type: 'caption.setSegmentText',
                          payload: {
                            documentId: document.id,
                            segmentId: segment.id,
                            textOverride: undefined,
                          },
                        },
                      ],
                    })
                  }
                >
                  <UndoIcon />
                </button>
              )}
              <button
                className="icon-button caption-delete-btn"
                aria-label={`Delete caption ${segment.id}`}
                title="Delete caption"
                onClick={() =>
                  onDispatch({
                    label: 'Delete caption',
                    commands: [
                      {
                        type: 'caption.removeSegment',
                        payload: { documentId: document.id, segmentId: segment.id },
                      },
                    ],
                  })
                }
              >
                <TrashIcon />
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
