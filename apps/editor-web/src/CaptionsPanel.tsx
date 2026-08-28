import { useId, useRef, useState, type ReactElement } from 'react';
import type {
  CaptionClipStyleV2,
  CaptionClipV1,
  CaptionDocumentV1,
  JoyProjectV1,
  TrackV1,
} from '@joy-media/project-schema';
import {
  canonicalBindingKey,
  captionClipStylePropertyBinding,
  IDENTITY_CAPTION_CLIP_STYLE,
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
import { BurnInIcon, LanguageIcon, PlusIcon, TrashIcon, UndoIcon, PngMaskIcon } from './icons.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { downloadBrowserTextFile } from './browser-text-download.js';
import { PropertyRow } from './components/PropertyRow.js';

type CaptionsTab = 'transcript' | 'style' | 'generate';

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
  onCreateCaptionTrack,
}: {
  readonly project: JoyProjectV1;
  readonly playheadUs: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
  readonly onTranscribe: (documentId: string, language: 'fa-IR' | 'en-US') => Promise<void>;
  readonly transcriptionError: string | undefined;
  readonly onProjectChange: (next: JoyProjectV1) => void;
  /** When supplied, creates the visual document and Classic timeline CC lane as one undo step. */
  readonly onCreateCaptionTrack?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<CaptionsTab>('transcript');
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
      search={{
        value: query,
        onChange: setQuery,
        placeholder: activeTab === 'transcript' ? 'Search caption text…' : 'Search…',
      }}
      tabs={[
        { id: 'transcript', label: 'Transcript' },
        { id: 'style', label: 'Style' },
        { id: 'generate', label: 'Generate' },
      ]}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as CaptionsTab)}
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
            onClick={() => {
              if (onCreateCaptionTrack !== undefined) onCreateCaptionTrack();
              else onProjectChange(createCaptionSlotProject(project));
            }}
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
            activeTab={activeTab}
            playheadUs={playheadUs}
            onSeek={onSeek}
            onDispatch={onDispatch}
            onTranscribe={onTranscribe}
            project={project}
            transcriptionError={transcriptionError}
          />
        ))
      )}
    </PanelShell>
  );
}

function CaptionSlotEditor({
  slot,
  query,
  activeTab,
  playheadUs,
  onSeek,
  onDispatch,
  onTranscribe,
  project,
  transcriptionError,
}: {
  readonly slot: CaptionSlot;
  readonly query: string;
  readonly activeTab: CaptionsTab;
  readonly playheadUs: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
  readonly onTranscribe: (documentId: string, language: 'fa-IR' | 'en-US') => Promise<void>;
  readonly project: JoyProjectV1;
  readonly transcriptionError: string | undefined;
}) {
  const { clip, document } = slot;
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [importIssues, setImportIssues] = useState(0);
  const [transcribingLanguage, setTranscribingLanguage] = useState<'fa-IR' | 'en-US'>();
  const transcriptionStatusId = useId();
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
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
  const clipStyle = clip.style ?? IDENTITY_CAPTION_CLIP_STYLE;
  const clipTimeUs = Math.max(0, playheadUs - clip.startUs);
  const setClipStyle = (next: CaptionClipStyleV2, label: string) =>
    onDispatch({
      label,
      commands: [{ type: 'caption.setClipStyle', payload: { clipId: clip.id, style: next } }],
    });
  const animatedStyleRow = (propertyId: 'opacity' | 'scale', value: number, label: string) => {
    const binding = captionClipStylePropertyBinding(clip.id, propertyId);
    const current = project.propertyAnimations?.[canonicalBindingKey(binding)];
    const curve = current?.value.kind === 'scalar' ? current.value.curve : undefined;
    const keyed = curve?.keyframes.some((key) => key.timeUs === clipTimeUs) === true;
    return {
      animationState: keyed
        ? ('keyed' as const)
        : curve === undefined
          ? ('none' as const)
          : ('between' as const),
      onToggleAnimation: () =>
        onDispatch({
          label: `${keyed ? 'Remove' : 'Add'} ${label} keyframe`,
          commands: [
            keyed
              ? { type: 'propertyAnimation.removeKey', payload: { binding, timeUs: clipTimeUs } }
              : curve === undefined
                ? {
                    type: 'propertyAnimation.replace',
                    payload: {
                      binding,
                      value: {
                        kind: 'scalar',
                        curve: {
                          keyframes: [{ timeUs: clipTimeUs, value, interpolation: 'linear' }],
                        },
                      },
                    },
                  }
                : {
                    type: 'propertyAnimation.setKey',
                    payload: {
                      binding,
                      key: {
                        kind: 'scalar',
                        keyframe: { timeUs: clipTimeUs, value, interpolation: 'linear' },
                      },
                    },
                  },
          ],
        }),
    };
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
  const transcriptionUnavailable = transcriptionError !== undefined;
  const commitSegmentText = (segmentId: string, currentText: string) => {
    const segment = document.segments.find((candidate) => candidate.id === segmentId);
    if (segment === undefined) return;
    const committedText = segmentDisplayText(document, segment);
    if (currentText !== committedText) {
      onDispatch({
        label: 'Edit caption text',
        commands: [
          {
            type: 'caption.setSegmentText',
            payload: { documentId: document.id, segmentId, textOverride: currentText },
          },
        ],
      });
    }
    setDrafts((current) => {
      const next = { ...current };
      delete next[segmentId];
      return next;
    });
  };
  return (
    <section aria-label={`Captions ${document.language}`}>
      <header className="captions-slot-header">
        <div className="caption-track-summary">
          <strong>{slot.trackId}</strong>
          <span className="caption-summary-chip">{document.language}</span>
          <span className="caption-summary-chip">{direction.toUpperCase()}</span>
          <span className="caption-summary-chip">{segments.length} cues</span>
        </div>
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
        <details className="caption-action-menu caption-overflow-menu">
          <summary aria-label="Caption track actions">More</summary>
          <div className="caption-overflow-panel">
            <button
              type="button"
              className="caption-menu-action"
              onClick={() => fileInput.current?.click()}
            >
              Import SRT/VTT
            </button>
            <button
              type="button"
              className="caption-menu-action"
              onClick={() => downloadBrowserTextFile(`${document.id}.srt`, formatSrt(document))}
            >
              Export SRT
            </button>
            <button
              type="button"
              className="caption-menu-action"
              onClick={() => downloadBrowserTextFile(`${document.id}.vtt`, formatWebVtt(document))}
            >
              Export VTT
            </button>
          </div>
        </details>
      </header>
      {transcribingLanguage !== undefined && (
        <p className="caption-transcription-status" role="status" aria-live="polite">
          Transcribing {transcribingLanguage === 'fa-IR' ? 'Persian' : 'English'}…
        </p>
      )}
      {transcriptionUnavailable && (
        <p
          id={transcriptionStatusId}
          className="caption-transcription-status"
          role="status"
          aria-live="polite"
        >
          Transcription unavailable: {transcriptionError}
        </p>
      )}
      {importIssues > 0 && (
        <p className="caption-warning">On import, {importIssues} bad cue(s) were skipped.</p>
      )}
      {activeTab === 'transcript' && (
        <>
          <div className="caption-transcript-toolbar">
            <button
              type="button"
              className="icon-button icon-button-labeled caption-add-primary"
              aria-label="Add caption"
              title="Add caption at playhead"
              onClick={addSegment}
            >
              <PlusIcon />
              <span>Add caption</span>
            </button>
            <span className="caption-tab-hint">Click a timestamp to seek</span>
          </div>
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
                    value={drafts[segment.id] ?? displayText}
                    dir={direction}
                    lang={document.language}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setDrafts((current) => ({
                        ...current,
                        [segment.id]: value,
                      }));
                    }}
                    onBlur={(event) => commitSegmentText(segment.id, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setDrafts((current) => {
                          const next = { ...current };
                          delete next[segment.id];
                          return next;
                        });
                        event.currentTarget.blur();
                      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        commitSegmentText(segment.id, event.currentTarget.value);
                        event.currentTarget.blur();
                      }
                    }}
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
        </>
      )}
      {activeTab === 'style' && (
        <CaptionStyleTab
          clipStyle={clipStyle}
          templateId={document.styleRef ?? DEFAULT_CAPTION_TEMPLATE_ID}
          onApplyTemplate={applyTemplate}
          onChange={setClipStyle}
          animatedStyleRow={animatedStyleRow}
        />
      )}
      {activeTab === 'generate' && (
        <section className="caption-generate-tab" aria-label="Generate captions">
          <p className="caption-tab-intro">Create a transcript from the selected timeline audio.</p>
          <div className="caption-generate-card">
            <span className="caption-status-dot" aria-hidden="true" />
            <div>
              <strong>Local transcription</strong>
              <span>Persian and English ready when the audio source is available.</span>
            </div>
          </div>
          <div className="caption-generate-actions">
            <button
              type="button"
              className="button button-primary"
              aria-busy={transcribingLanguage === 'fa-IR'}
              disabled={transcribingLanguage !== undefined}
              aria-describedby={transcriptionUnavailable ? transcriptionStatusId : undefined}
              onClick={() => void transcribe('fa-IR')}
            >
              <LanguageIcon label="FA" />
              Generate Persian
            </button>
            <button
              type="button"
              className="button"
              aria-busy={transcribingLanguage === 'en-US'}
              disabled={transcribingLanguage !== undefined}
              aria-describedby={transcriptionUnavailable ? transcriptionStatusId : undefined}
              onClick={() => void transcribe('en-US')}
            >
              Generate English
            </button>
          </div>
        </section>
      )}
    </section>
  );
}

function CaptionStyleTab({
  clipStyle,
  templateId,
  onApplyTemplate,
  onChange,
  animatedStyleRow,
}: {
  readonly clipStyle: CaptionClipStyleV2;
  readonly templateId: string;
  readonly onApplyTemplate: (styleRef: string) => void;
  readonly onChange: (style: CaptionClipStyleV2, label: string) => void;
  readonly animatedStyleRow: (
    propertyId: 'opacity' | 'scale',
    value: number,
    label: string,
  ) => {
    readonly animationState: 'none' | 'between' | 'keyed';
    readonly onToggleAnimation: () => void;
  };
}) {
  const numeric = (
    property: 'positionX' | 'positionY' | 'fontSize' | 'tracking' | 'lineHeight' | 'plateOpacity',
    label: string,
    min: number,
    max: number,
    step: number,
  ) => (
    <PropertyRow label={label} value={clipStyle[property].toFixed(2)}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={clipStyle[property]}
        aria-label={`Caption ${label.toLowerCase()}`}
        onChange={(event) =>
          onChange(
            { ...clipStyle, [property]: event.currentTarget.valueAsNumber },
            `Set caption ${label.toLowerCase()}`,
          )
        }
      />
    </PropertyRow>
  );
  return (
    <div className="caption-style-tab">
      <section className="caption-style-section" aria-labelledby="caption-template-heading">
        <h4 id="caption-template-heading">Template</h4>
        <div className="captions-template-cards" role="group" aria-label="Caption template">
          {JOY_CAPTION_TEMPLATES.map((template) => {
            const meta = TEMPLATE_ICONS[template.id];
            const Icon = meta?.Icon ?? (() => <PngMaskIcon src="/assets/24_Text.png" size={14} />);
            const active = templateId === template.id;
            return (
              <button
                key={template.id}
                type="button"
                className="caption-template-card"
                aria-pressed={active}
                onClick={() => onApplyTemplate(template.id)}
              >
                <Icon />
                <span>{meta?.label ?? template.name}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="caption-style-section" aria-labelledby="caption-type-heading">
        <h4 id="caption-type-heading">Type</h4>
        {numeric('fontSize', 'Font size', 0.5, 2, 0.01)}
        {numeric('tracking', 'Tracking', -0.2, 0.5, 0.01)}
        {numeric('lineHeight', 'Line height', 0.8, 2, 0.01)}
        <label className="caption-select-row">
          <span>Align</span>
          <select
            value={clipStyle.align}
            aria-label="Caption alignment"
            onChange={(event) =>
              onChange(
                { ...clipStyle, align: event.currentTarget.value as CaptionClipStyleV2['align'] },
                'Set caption alignment',
              )
            }
          >
            <option value="start">Start</option>
            <option value="center">Center</option>
            <option value="end">End</option>
          </select>
        </label>
      </section>
      <section className="caption-style-section" aria-labelledby="caption-placement-heading">
        <h4 id="caption-placement-heading">Placement</h4>
        {numeric('positionX', 'Position X', -0.4, 0.4, 0.01)}
        {numeric('positionY', 'Position Y', -0.4, 0.4, 0.01)}
        <PropertyRow
          label="Scale"
          value={clipStyle.scale.toFixed(2)}
          {...animatedStyleRow('scale', clipStyle.scale, 'Scale')}
        >
          <input
            type="range"
            min={0.25}
            max={3}
            step={0.01}
            value={clipStyle.scale}
            aria-label="Caption scale"
            onChange={(event) =>
              onChange(
                { ...clipStyle, scale: event.currentTarget.valueAsNumber },
                'Set caption scale',
              )
            }
          />
        </PropertyRow>
        <PropertyRow
          label="Opacity"
          value={clipStyle.opacity.toFixed(2)}
          {...animatedStyleRow('opacity', clipStyle.opacity, 'Opacity')}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={clipStyle.opacity}
            aria-label="Caption opacity"
            onChange={(event) =>
              onChange(
                { ...clipStyle, opacity: event.currentTarget.valueAsNumber },
                'Set caption opacity',
              )
            }
          />
        </PropertyRow>
      </section>
      <section className="caption-style-section" aria-labelledby="caption-colors-heading">
        <h4 id="caption-colors-heading">Colors</h4>
        <label className="caption-color-row">
          <span>Text</span>
          <input
            type="color"
            value={clipStyle.textColor}
            onChange={(event) =>
              onChange(
                { ...clipStyle, textColor: event.currentTarget.value },
                'Set caption text color',
              )
            }
          />
        </label>
        <label className="caption-color-row">
          <span>Highlight</span>
          <input
            type="color"
            value={clipStyle.highlightColor}
            onChange={(event) =>
              onChange(
                { ...clipStyle, highlightColor: event.currentTarget.value },
                'Set caption highlight color',
              )
            }
          />
        </label>
        <label className="caption-color-row">
          <span>Plate</span>
          <input
            type="color"
            value={clipStyle.plateColor}
            onChange={(event) =>
              onChange(
                { ...clipStyle, plateColor: event.currentTarget.value },
                'Set caption plate color',
              )
            }
          />
        </label>
        {numeric('plateOpacity', 'Plate opacity', 0, 1, 0.01)}
      </section>
    </div>
  );
}
