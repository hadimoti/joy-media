import { useRef, useState, type ReactElement } from 'react';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  captionCuesAt,
  captionSlots,
  DEFAULT_CAPTION_TEMPLATE_ID,
  DEFAULT_CONFIDENCE_WARNING_THRESHOLD,
  formatSrt,
  formatWebVtt,
  JOY_CAPTION_TEMPLATES,
  layoutTemplatedCaptionNodes,
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
import type { TextNode } from '@joy-media/render-ir';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import {
  AutoCaptionIcon,
  BurnInIcon,
  CaptionCleanIcon,
  CaptionKaraokeIcon,
  CaptionRtlIcon,
  DownloadIcon,
  LanguageIcon,
  MicIcon,
  PlusIcon,
  TrashIcon,
  UndoIcon,
  UploadIcon,
} from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

const TABS: readonly PanelTabSpec[] = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'preview', label: 'Preview' },
];
import { readCaptionBurnIn, withCaptionBurnIn } from './caption-burn-in.js';

const TEMPLATE_ICONS: Readonly<
  Record<string, { readonly Icon: () => ReactElement; readonly label: string }>
> = {
  'joy-clean': { Icon: CaptionCleanIcon, label: 'JOY Clean' },
  'joy-karaoke-pop': { Icon: CaptionKaraokeIcon, label: 'JOY Karaoke Pop' },
  'joy-rtl-classic': { Icon: CaptionRtlIcon, label: 'JOY RTL Classic' },
};

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
  const [tab, setTab] = useState('transcript');
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
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      search={{ value: query, onChange: setQuery, placeholder: 'جست‌وجوی رونویسی…' }}
      inactive={idle}
      {...(idle
        ? { note: 'برای شروع رونویسی، یک ترک زیرنویس اضافه کنید.' }
        : transcriptionError !== undefined
          ? { note: `${transcriptionError} می‌توانید ویرایش زیرنویس را به‌صورت دستی ادامه دهید.` }
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
      {tab === 'preview' && <CaptionPreview project={project} playheadUs={playheadUs} />}

      {tab === 'transcript' &&
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
        ))}
    </PanelShell>
  );
}

/** Renders the templated caption layout at the playhead, scaled to a small stage. */
function CaptionPreview({
  project,
  playheadUs,
}: {
  readonly project: JoyProjectV1;
  readonly playheadUs: number;
}) {
  const composition = project.compositions[project.rootCompositionId]!;
  const cues = captionCuesAt(composition, project.captionDocuments, playheadUs);
  const nodes = layoutTemplatedCaptionNodes(cues, {
    viewportWidth: composition.width,
    viewportHeight: composition.height,
  }) as readonly TextNode[];
  const stageWidth = 360;
  const scale = stageWidth / composition.width;
  return (
    <div
      className="caption-preview"
      style={{ width: stageWidth, height: composition.height * scale }}
      aria-label="Caption preview"
    >
      {nodes.map((node) => (
        <span
          key={node.id}
          dir={node.direction}
          style={{
            position: 'absolute',
            top: node.transform.translateY * scale,
            left: node.transform.translateX * scale,
            transform:
              node.align === 'center'
                ? 'translateX(-50%)'
                : node.align === 'right'
                  ? 'translateX(-100%)'
                  : undefined,
            fontSize: (node.fontSizePx ?? 24) * scale,
            lineHeight: 1.15,
            whiteSpace: 'nowrap',
            color: rgbaCss(node.color),
            backgroundColor: node.background === undefined ? undefined : rgbaCss(node.background),
            padding: node.background === undefined ? undefined : '0.05em 0.35em',
            borderRadius: '0.15em',
          }}
        >
          {node.spans === undefined
            ? node.text
            : node.spans.map((span, index) => (
                <span
                  key={index}
                  style={{
                    color: rgbaCss(span.color),
                    fontWeight: span.emphasis === true ? 700 : undefined,
                  }}
                >
                  {span.text}
                </span>
              ))}
        </span>
      ))}
    </div>
  );
}

function rgbaCss(color: { r: number; g: number; b: number; a: number }): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${(color.a / 255).toFixed(3)})`;
}

function downloadTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
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
  return (
    <section aria-label={`Captions ${document.language}`}>
      <header className="captions-slot-header">
        <strong>
          {document.language} · {direction.toUpperCase()}
        </strong>
        <div className="captions-template-icons" role="group" aria-label="Caption template">
          {JOY_CAPTION_TEMPLATES.map((template) => {
            const meta = TEMPLATE_ICONS[template.id];
            const Icon = meta?.Icon ?? CaptionCleanIcon;
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
          onClick={() => downloadTextFile(`${document.id}.srt`, formatSrt(document))}
        >
          <DownloadIcon />
        </button>
        <button
          className="icon-button"
          aria-label="Export captions as WebVTT"
          data-guide="Export VTT"
          onClick={() => downloadTextFile(`${document.id}.vtt`, formatWebVtt(document))}
        >
          <DownloadIcon />
        </button>
        <button
          className="icon-button"
          aria-label="Import captions"
          title="Import SRT/VTT file"
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon />
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
          data-guide="Auto caption"
          onClick={() => void onTranscribe(document.id, 'en-US')}
        >
          <AutoCaptionIcon />
        </button>
        <button
          className="icon-button"
          aria-label="Transcribe Persian"
          data-guide="Persian (fa)"
          onClick={() => void onTranscribe(document.id, 'fa-IR')}
        >
          <LanguageIcon label="FA" />
        </button>
        <button
          className="icon-button"
          aria-label="Transcribe English"
          data-guide="English (en)"
          onClick={() => void onTranscribe(document.id, 'en-US')}
        >
          <MicIcon />
        </button>
      </header>
      {importIssues > 0 && (
        <p className="caption-warning" lang="fa">
          هنگام وارد کردن، {importIssues} کیوی معیوب نادیده گرفته شد.
        </p>
      )}
      {segments.length === 0 && <p lang="fa">زیرنویس مطابقی پیدا نشد.</p>}
      <ol className="captions-list">
        {segments.map((segment) => {
          const range = segmentTimelineRange(clip, segment);
          const active =
            range !== undefined &&
            playheadUs >= range.startUs &&
            playheadUs < range.startUs + range.durationUs;
          const display = segmentDisplayText(document, segment);
          const source = segmentSourceText(document, segment);
          const confidence = segmentMinConfidence(document, segment);
          const lowConfidence =
            confidence !== undefined && confidence < DEFAULT_CONFIDENCE_WARNING_THRESHOLD;
          const commitText = (value: string) => {
            if (value === display) return;
            onDispatch({
              label: 'Edit caption text',
              commands: [
                {
                  type: 'caption.setSegmentText',
                  payload: {
                    documentId: document.id,
                    segmentId: segment.id,
                    // Typing the source text back reverts to the source tokens.
                    textOverride: value === source ? undefined : value,
                  },
                },
              ],
            });
          };
          const commitTiming = (startSeconds: number, endSeconds: number) => {
            const startUs = Math.round(startSeconds * 1_000_000);
            const endUs = Math.round(endSeconds * 1_000_000);
            if (startUs === segment.startUs && endUs === segment.endUs) return;
            if (startUs < 0 || endUs <= startUs) return;
            onDispatch({
              label: 'Retime caption',
              commands: [
                {
                  type: 'caption.setSegmentTiming',
                  payload: { documentId: document.id, segmentId: segment.id, startUs, endUs },
                },
              ],
            });
          };
          return (
            <li key={segment.id} className={active ? 'caption-row active' : 'caption-row'}>
              <button
                aria-label={`Seek to caption ${segment.id}`}
                onClick={() => range !== undefined && onSeek(range.startUs)}
              >
                {(segment.startUs / 1_000_000).toFixed(2)}s
              </button>
              <TimingField
                label="Start (s)"
                value={segment.startUs / 1_000_000}
                onCommit={(value) => commitTiming(value, segment.endUs / 1_000_000)}
              />
              <TimingField
                label="End (s)"
                value={segment.endUs / 1_000_000}
                onCommit={(value) => commitTiming(segment.startUs / 1_000_000, value)}
              />
              <input
                key={`${segment.id}:${display}`}
                aria-label={`Caption text ${segment.id}`}
                dir={direction}
                defaultValue={display}
                title={segment.textOverride === undefined ? undefined : `Source: ${source}`}
                onBlur={(event) => commitText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              {lowConfidence && (
                <span className="caption-warning" title="Low transcription confidence">
                  ⚠ {Math.round(confidence * 100)}%
                </span>
              )}
              {segment.textOverride !== undefined && (
                <button
                  className="icon-button"
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
                className="icon-button"
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

function TimingField({
  label,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly onCommit: (value: number) => void;
}) {
  return (
    <input
      key={value}
      aria-label={label}
      type="number"
      step={0.05}
      min={0}
      defaultValue={value.toFixed(2)}
      onBlur={(event) => {
        const next = event.currentTarget.valueAsNumber;
        if (Number.isFinite(next)) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
