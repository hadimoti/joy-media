/**
 * Joy Code's picture, video and job messages (T-C05).
 *
 * A message is a list of parts: text, a picture, a video or a job card. Media
 * is read by job id through `readMedia` (a bytes channel owned by the main
 * process) and shown from a short-lived blob link; this file never sees a file
 * path. The four action buttons call the handlers the parent passes in; with no
 * handler they do nothing, so T-C06 can wire the real ones without a change here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { releaseMediaObjectUrl } from './media-object-url.js';
import type { JoyCodeJobState, JoyCodeMessagePart } from './joy-code-history.js';

/** The bytes of a finished job, or undefined when the main process has none. */
export type JoyCodeMediaReader = (
  jobId: string,
) => Promise<{ readonly bytes: Uint8Array; readonly mimeType: string } | undefined>;

export interface JoyCodeMediaActions {
  readonly onCancel?: ((jobId: string) => void) | undefined;
  readonly onAddToLibrary?: ((jobId: string) => void) | undefined;
  readonly onPlaceOnTimeline?: ((jobId: string) => void) | undefined;
  readonly onSaveAs?: ((jobId: string) => void) | undefined;
  readonly onDiscard?: ((jobId: string) => void) | undefined;
}

export interface JoyCodeMediaPartsProps extends JoyCodeMediaActions {
  readonly parts: readonly JoyCodeMessagePart[];
  readonly readMedia?: JoyCodeMediaReader | undefined;
  /** The clock for elapsed time; tests pass a fixed one. */
  readonly now?: (() => number) | undefined;
}

const ACTIVE_STATES: readonly JoyCodeJobState[] = ['queued', 'running', 'downloading'];

const STATE_WORDS: Readonly<Record<JoyCodeJobState, string>> = {
  queued: 'Waiting',
  running: 'Working',
  downloading: 'Saving',
  completed: 'Done',
  failed: 'Could not make it',
  cancelled: 'Cancelled',
  'abandoned-locally': 'Stopped on this computer',
  'timed-out': 'Took too long',
};

export function joyCodeJobStateWords(state: JoyCodeJobState): string {
  return STATE_WORDS[state];
}

export function formatJoyCodeElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

type MediaLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'failed' };

/** Reads the bytes for one job and owns the blob link made from them. */
function useJobMediaUrl(
  jobId: string,
  readMedia: JoyCodeMediaReader | undefined,
  attempt: number,
  elementRef: RefObject<HTMLImageElement | HTMLVideoElement | null>,
): MediaLoad {
  const [load, setLoad] = useState<MediaLoad>({ status: 'loading' });
  // The reader is held in a ref: a caller that passes a new inline function on every render must not make
  // every picture reload. Only the job, a retry, or a reader appearing or vanishing restarts the read.
  const readMediaRef = useRef(readMedia);
  readMediaRef.current = readMedia;
  const hasReader = readMedia !== undefined;
  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    setLoad({ status: 'loading' });
    const read = readMediaRef.current;
    if (read === undefined) {
      setLoad({ status: 'failed' });
      return undefined;
    }
    read(jobId).then(
      (media) => {
        if (cancelled) return;
        if (media === undefined || media.bytes.byteLength === 0) {
          setLoad({ status: 'failed' });
          return;
        }
        url = URL.createObjectURL(new Blob([media.bytes as BlobPart], { type: media.mimeType }));
        setLoad({ status: 'ready', url });
      },
      () => {
        if (!cancelled) setLoad({ status: 'failed' });
      },
    );
    return () => {
      cancelled = true;
      // Clears the element that still shows the link before it is revoked.
      // The latest element is wanted here: it mounts after the effect runs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (url !== undefined) releaseMediaObjectUrl(elementRef.current, url);
    };
  }, [jobId, hasReader, attempt, elementRef]);
  return load;
}

function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      className="joy-code-media-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  library: (
    <Icon>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M8 6v4M6 8h4" />
    </Icon>
  ),
  timeline: (
    <Icon>
      <path d="M2.5 5h11M2.5 8h7M2.5 11h9" />
    </Icon>
  ),
  save: (
    <Icon>
      <path d="M8 2.5v7M5 7l3 3 3-3M3 13h10" />
    </Icon>
  ),
  discard: (
    <Icon>
      <path d="M3.5 4.5h9M6.5 4.5v-1.5h3v1.5M5 4.5l.5 8h5l.5-8" />
    </Icon>
  ),
  cancel: (
    <Icon>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  ),
  picture: (
    <Icon>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M3 11l3.5-3.5 3 3 1.5-1.5 2.5 2.5" />
    </Icon>
  ),
  video: (
    <Icon>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <path d="M7 6l3 2-3 2z" />
    </Icon>
  ),
};

function MediaButtons({
  jobId,
  actions,
}: {
  readonly jobId: string;
  readonly actions: JoyCodeMediaActions;
}) {
  const { onAddToLibrary, onPlaceOnTimeline, onSaveAs, onDiscard } = actions;
  return (
    <div className="joy-code-media-actions" role="group" aria-label="Media actions">
      <button type="button" className="button-secondary" onClick={() => onAddToLibrary?.(jobId)}>
        {ICONS.library}
        Add to library
      </button>
      <button type="button" className="button-secondary" onClick={() => onPlaceOnTimeline?.(jobId)}>
        {ICONS.timeline}
        Place on timeline
      </button>
      <button type="button" className="button-secondary" onClick={() => onSaveAs?.(jobId)}>
        {ICONS.save}
        Save as
      </button>
      <button type="button" className="button-secondary" onClick={() => onDiscard?.(jobId)}>
        {ICONS.discard}
        Discard
      </button>
    </div>
  );
}

function MediaProblem({
  kind,
  onRetry,
}: {
  readonly kind: 'image' | 'video';
  readonly onRetry: () => void;
}) {
  return (
    <div className="joy-code-media-problem" role="status">
      <span>{kind === 'image' ? 'Could not open the picture' : 'Could not open the video'}</span>
      <button type="button" className="button-secondary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function Lightbox({
  url,
  label,
  onClose,
}: {
  readonly url: string;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return (
    <div
      className="joy-code-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        } else if (event.key === 'Tab') {
          // The close button is the only control: keep focus inside the dialog.
          event.preventDefault();
          closeRef.current?.focus();
        }
      }}
    >
      <img
        className="joy-code-lightbox-image"
        src={url}
        alt={label}
        onClick={(event) => event.stopPropagation()}
      />
      <button
        ref={closeRef}
        type="button"
        className="joy-code-lightbox-close button-secondary"
        aria-label="Close"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        {ICONS.cancel}
      </button>
    </div>
  );
}

function PictureCard({
  jobId,
  label,
  readMedia,
  actions,
}: {
  readonly jobId: string;
  readonly label: string | undefined;
  readonly readMedia: JoyCodeMediaReader | undefined;
  readonly actions: JoyCodeMediaActions;
}) {
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const thumbRef = useRef<HTMLButtonElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const load = useJobMediaUrl(jobId, readMedia, attempt, imageRef);
  const name = label ?? 'Generated picture';
  const close = useCallback(() => {
    setOpen(false);
    thumbRef.current?.focus();
  }, []);
  return (
    <figure className="joy-code-media-card is-image" aria-label={name}>
      {load.status === 'loading' && (
        <div className="joy-code-media-loading" role="status">
          Loading
        </div>
      )}
      {load.status === 'failed' && (
        <MediaProblem kind="image" onRetry={() => setAttempt((value) => value + 1)} />
      )}
      {load.status === 'ready' && (
        <>
          <button
            ref={thumbRef}
            type="button"
            className="joy-code-media-thumb"
            aria-label={`Open ${name}`}
            onClick={() => setOpen(true)}
          >
            <img ref={imageRef} src={load.url} alt={name} />
          </button>
          {open && <Lightbox url={load.url} label={name} onClose={close} />}
          <MediaButtons jobId={jobId} actions={actions} />
        </>
      )}
    </figure>
  );
}

function VideoCard({
  jobId,
  label,
  readMedia,
  actions,
}: {
  readonly jobId: string;
  readonly label: string | undefined;
  readonly readMedia: JoyCodeMediaReader | undefined;
  readonly actions: JoyCodeMediaActions;
}) {
  const [attempt, setAttempt] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const load = useJobMediaUrl(jobId, readMedia, attempt, videoRef);
  const name = label ?? 'Generated video';
  return (
    <figure className="joy-code-media-card is-video" aria-label={name}>
      {load.status === 'loading' && (
        <div className="joy-code-media-loading" role="status">
          Loading
        </div>
      )}
      {load.status === 'failed' && (
        <MediaProblem kind="video" onRetry={() => setAttempt((value) => value + 1)} />
      )}
      {load.status === 'ready' && (
        <>
          <video
            ref={videoRef}
            className="joy-code-media-video"
            src={load.url}
            controls
            preload="metadata"
            aria-label={name}
          />
          <MediaButtons jobId={jobId} actions={actions} />
        </>
      )}
    </figure>
  );
}

function JobCard({
  part,
  now,
  onCancel,
}: {
  readonly part: Extract<JoyCodeMessagePart, { kind: 'job' }>;
  readonly now: () => number;
  readonly onCancel: ((jobId: string) => void) | undefined;
}) {
  const active = ACTIVE_STATES.includes(part.state);
  const [tick, setTick] = useState(() => now());
  useEffect(() => {
    if (!active) return undefined;
    setTick(now());
    const timer = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(timer);
  }, [active, now]);

  const started = Date.parse(part.startedAt);
  const ended = part.endedAt === undefined ? tick : Date.parse(part.endedAt);
  const elapsed =
    Number.isFinite(started) && Number.isFinite(ended)
      ? formatJoyCodeElapsed(ended - started)
      : undefined;
  const kindName = part.mediaKind === 'image' ? 'Picture' : 'Video';
  const problem = part.state === 'failed' || part.state === 'timed-out';

  return (
    <section
      className={`joy-code-job-card is-${part.state}${problem ? ' is-problem' : ''}`}
      aria-label={`${kindName} job`}
      role="status"
    >
      <span className="joy-code-job-kind">
        {part.mediaKind === 'image' ? ICONS.picture : ICONS.video}
        {kindName}
      </span>
      <span className="joy-code-job-state">{STATE_WORDS[part.state]}</span>
      {elapsed !== undefined && <span className="joy-code-job-elapsed">{elapsed}</span>}
      {part.reason !== undefined && part.reason !== '' && (
        <span className="joy-code-job-reason">{part.reason}</span>
      )}
      {active && (
        <button
          type="button"
          className="joy-code-job-cancel button-secondary"
          onClick={() => onCancel?.(part.jobId)}
        >
          {ICONS.cancel}
          Cancel
        </button>
      )}
    </section>
  );
}

export function JoyCodeMediaParts({
  parts,
  readMedia,
  now = Date.now,
  ...actions
}: JoyCodeMediaPartsProps) {
  return (
    <div className="joy-code-parts">
      {parts.map((part, index) => {
        const key = `${index}-${part.kind}`;
        switch (part.kind) {
          case 'text':
            return (
              <p key={key} className="joy-code-part-text">
                {part.text}
              </p>
            );
          case 'image':
            return (
              <PictureCard
                key={`${key}-${part.jobId}`}
                jobId={part.jobId}
                label={part.label}
                readMedia={readMedia}
                actions={actions}
              />
            );
          case 'video':
            return (
              <VideoCard
                key={`${key}-${part.jobId}`}
                jobId={part.jobId}
                label={part.label}
                readMedia={readMedia}
                actions={actions}
              />
            );
          case 'job':
            return (
              <JobCard
                key={`${key}-${part.jobId}`}
                part={part}
                now={now}
                onCancel={actions.onCancel}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
