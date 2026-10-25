import { useEffect, useRef, useState } from 'react';
import {
  isDesktopHost,
  readDesktopDerivative,
  requestDesktopThumbnail,
  stageDesktopMedia,
  startDesktopWorker,
  waitForDesktopJob,
  type DesktopJobView,
} from './desktop-client.js';
import { revokeDetachedObjectUrl } from './media-object-url.js';

/**
 * Asks the desktop Worker for a thumbnail of one imported video. The original is staged to the
 * desktop once per hash (a verified copy is reused afterwards), the Worker renders the JPEG, and the
 * JPEG is read back and verified before it is shown. Nothing here changes the project.
 */

export interface DesktopThumbnailSource {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
}

type ThumbnailState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'staging'; readonly ratio: number }
  | { readonly phase: 'rendering'; readonly job: DesktopJobView }
  | { readonly phase: 'done'; readonly url: string }
  | { readonly phase: 'failed'; readonly message: string };

function describeJob(job: DesktopJobView): string {
  if (job.status === 'queued') return 'Waiting for the desktop worker…';
  if (job.status === 'running')
    return `Rendering thumbnail${job.progress === undefined ? '' : ` ${Math.round(job.progress)}%`}…`;
  return job.status;
}

export function DesktopThumbnailAction({
  asset,
  loadOriginal,
}: {
  readonly asset: DesktopThumbnailSource;
  /** Resolves the original's bytes from this device or the authenticated cloud copy. */
  readonly loadOriginal: () => Promise<Blob | undefined>;
}) {
  const [state, setState] = useState<ThumbnailState>({ phase: 'idle' });
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const thumbnailUrlRef = useRef<string | undefined>(undefined);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (thumbnailUrlRef.current !== undefined) revokeDetachedObjectUrl(thumbnailUrlRef.current);
    },
    [],
  );

  if (!isDesktopHost() || asset.kind !== 'video') return null;

  async function run(): Promise<void> {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ phase: 'staging', ratio: 0 });
    try {
      const original = await loadOriginal();
      if (original === undefined)
        throw new Error('The original is not on this device yet. Open the project online once.');
      const source = { sha256: asset.sha256, bytes: asset.bytes, displayName: asset.displayName };
      const ref = await stageDesktopMedia(source, original, (ratio) => {
        if (!controller.signal.aborted) setState({ phase: 'staging', ratio });
      });
      await startDesktopWorker();
      const jobId = await requestDesktopThumbnail(ref);
      const job = await waitForDesktopJob(jobId, {
        signal: controller.signal,
        onUpdate: (update) => {
          if (!controller.signal.aborted) setState({ phase: 'rendering', job: update });
        },
      });
      if (job.status !== 'done') throw new Error(job.error ?? `The thumbnail ${job.status}.`);
      const url = URL.createObjectURL(await readDesktopDerivative(jobId));
      if (controller.signal.aborted) {
        revokeDetachedObjectUrl(url);
        return;
      }
      if (thumbnailUrlRef.current !== undefined) revokeDetachedObjectUrl(thumbnailUrlRef.current);
      thumbnailUrlRef.current = url;
      setState({ phase: 'done', url });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({
        phase: 'failed',
        message: error instanceof Error ? error.message : 'Thumbnail failed',
      });
    }
  }

  const busy = state.phase === 'staging' || state.phase === 'rendering';
  const label =
    state.phase === 'staging'
      ? `Copying to desktop ${Math.round(state.ratio * 100)}%`
      : state.phase === 'rendering'
        ? describeJob(state.job)
        : state.phase === 'done'
          ? 'Desktop thumbnail ready'
          : state.phase === 'failed'
            ? state.message
            : '';

  return (
    <div className="desktop-thumbnail-action">
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        aria-label={`Make desktop thumbnail for ${asset.displayName}`}
        onClick={() => void run()}
      >
        Desktop thumbnail
      </button>
      {state.phase !== 'idle' && (
        <p className="desktop-thumbnail-status" role="status">
          {label}
        </p>
      )}
      {state.phase === 'done' && (
        <img
          className="desktop-thumbnail-image"
          src={state.url}
          alt={`Desktop thumbnail of ${asset.displayName}`}
        />
      )}
    </div>
  );
}
