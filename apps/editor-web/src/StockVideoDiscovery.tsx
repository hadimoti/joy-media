import { useCallback, useEffect, useRef, useState } from 'react';
import {
  STOCK_VIDEO_CATEGORIES,
  type BrowserStockVideo,
  type BrowserStockVideoCategory,
  type BrowserControlPlaneClient,
} from './control-plane-client.js';
import type { AssetViewMode } from './asset-library-state.js';
import { ExportIcon, UploadIcon } from './icons.js';
import {
  revokeDetachedObjectUrl,
  usePendingObjectUrlOwner,
  useReleasableObjectUrl,
} from './media-object-url.js';

const STOCK_VIDEO_PAGE_SIZE = 6;
const IMPORT_POLL_INTERVAL_MS = 750;
const IMPORT_POLL_LIMIT = 80;

export function StockVideoDiscovery({
  client,
  projectId: _projectId,
  query,
  category,
  categoryCounts,
  onCategoryCountsChange,
  viewMode,
  onImport,
  onStatus,
}: {
  readonly client: BrowserControlPlaneClient;
  readonly projectId: string;
  readonly query: string;
  readonly category: BrowserStockVideoCategory;
  readonly categoryCounts: Readonly<Record<BrowserStockVideoCategory, number>>;
  readonly onCategoryCountsChange: (
    counts: Readonly<Partial<Record<BrowserStockVideoCategory, number>>>,
  ) => void;
  readonly viewMode: AssetViewMode;
  readonly onImport: (video: BrowserStockVideo) => Promise<void>;
  readonly onStatus: (status: string | undefined) => void;
}) {
  const [videos, setVideos] = useState<readonly BrowserStockVideo[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState<string | undefined>(undefined);
  const [failedImports, setFailedImports] = useState<ReadonlySet<string>>(() => new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const [preview, setPreview] = useState<{
    readonly video: BrowserStockVideo;
    readonly url: string;
    readonly posterUrl?: string;
  }>();
  const requestSequence = useRef(0);
  const previewRequestSequence = useRef(0);
  const previewOpenerRef = useRef<HTMLButtonElement | null>(null);
  const previewCloseRef = useRef<HTMLButtonElement | null>(null);
  const pendingModalPreviewOwner = usePendingObjectUrlOwner();
  const previewVideoRef = useReleasableObjectUrl<HTMLVideoElement>(
    preview?.url,
    preview?.posterUrl,
    revokeDetachedObjectUrl,
    pendingModalPreviewOwner,
  );
  const previewVideoElementRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoConsumerRef = useCallback(
    (element: HTMLVideoElement | null): void => {
      previewVideoRef(element);
      previewVideoElementRef.current = element;
    },
    [previewVideoRef],
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewRequestSequence.current += 1;
      pendingModalPreviewOwner.revokePending();
    };
  }, [pendingModalPreviewOwner]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    let cancelled = false;
    setState('loading');
    setError(undefined);
    onStatus(undefined);
    void client
      .stockVideos(category, query)
      .then((page) => {
        if (cancelled || sequence !== requestSequence.current) return;
        setVideos(page.items.slice(0, STOCK_VIDEO_PAGE_SIZE));
        onCategoryCountsChange(page.counts);
        setState('ready');
      })
      .catch((reason: unknown) => {
        if (cancelled || sequence !== requestSequence.current) return;
        const detail = reason instanceof Error ? reason.message : 'Stock video discovery failed';
        setVideos([]);
        setState('error');
        setError(detail);
        onStatus(`Native video library unavailable: ${detail}`);
      });
    return () => {
      cancelled = true;
    };
  }, [category, client, onCategoryCountsChange, onStatus, query, reloadToken]);

  const closePreview = useCallback((): void => {
    previewRequestSequence.current += 1;
    pendingModalPreviewOwner.revokePending();
    const opener = previewOpenerRef.current;
    setPreview(undefined);
    window.setTimeout(() => opener?.focus(), 0);
  }, [pendingModalPreviewOwner]);

  useEffect(() => {
    if (preview === undefined) return;
    previewCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePreview();
        return;
      }
      if (event.key !== 'Tab') return;
      const first = previewCloseRef.current;
      const last = previewVideoElementRef.current;
      if (first === null || last === null) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closePreview, preview]);

  const openPreview = async (
    video: BrowserStockVideo,
    opener: HTMLButtonElement,
  ): Promise<void> => {
    previewOpenerRef.current = opener;
    const sequence = ++previewRequestSequence.current;
    pendingModalPreviewOwner.revokePending();
    setPreview(undefined);
    onStatus(`Loading preview for ${video.title}…`);
    try {
      const [previewBlob, posterBlob] = await Promise.all([
        client.stockVideoPreview(video.id),
        client.stockVideoPoster(video.id).catch(() => undefined),
      ]);
      if (!mountedRef.current || sequence !== previewRequestSequence.current) return;
      const previewUrl = URL.createObjectURL(previewBlob);
      const posterUrl = posterBlob === undefined ? undefined : URL.createObjectURL(posterBlob);
      pendingModalPreviewOwner.track(previewUrl, posterUrl);
      const next = {
        video,
        url: previewUrl,
        ...(posterUrl === undefined ? {} : { posterUrl }),
      };
      setPreview(next);
      onStatus(`Preview ready for ${video.title}.`);
    } catch (reason: unknown) {
      if (!mountedRef.current || sequence !== previewRequestSequence.current) return;
      onStatus(
        `Preview unavailable for ${video.title}: ${reason instanceof Error ? reason.message : 'try again'}`,
      );
    }
  };

  const importVideo = async (video: BrowserStockVideo): Promise<void> => {
    setImporting(video.id);
    setFailedImports((current) => {
      const next = new Set(current);
      next.delete(video.id);
      return next;
    });
    onStatus(`Importing ${video.title} to My media…`);
    try {
      await onImport(video);
    } catch (reason: unknown) {
      setFailedImports((current) => new Set(current).add(video.id));
      onStatus(
        `Import failed for ${video.title}: ${reason instanceof Error ? reason.message : 'try again'}`,
      );
    } finally {
      setImporting(undefined);
    }
  };

  const categoryLabel =
    STOCK_VIDEO_CATEGORIES.find((item) => item.id === category)?.label ?? category;
  return (
    <section
      className="stock-video-discovery"
      role="tabpanel"
      id="stock-video-panel"
      aria-labelledby={`stock-video-category-${category}`}
      tabIndex={0}
    >
      <div className="stock-video-heading">
        <div>
          <strong>JOY stock videos</strong>
          <span>Curated clips for your next edit · {categoryLabel}</span>
        </div>
        <span
          className="stock-video-count"
          aria-label={`${categoryCounts[category]} clips in this category`}
        >
          {categoryCounts[category]} clips
        </span>
      </div>
      {state === 'loading' && (
        <>
          <ul
            className={`stock-video-grid stock-video-grid--${viewMode}`}
            aria-label="Loading stock videos"
          >
            {Array.from({ length: STOCK_VIDEO_PAGE_SIZE }, (_, index) => (
              <li
                className="stock-video-card stock-video-card--skeleton"
                key={index}
                aria-hidden="true"
              >
                <span className="stock-video-poster" />
                <span className="stock-video-card-copy" />
                <span className="stock-video-card-actions" />
              </li>
            ))}
          </ul>
          <div
            className="stock-video-state stock-video-loading-label"
            role="status"
            aria-live="polite"
          >
            Loading native JOY videos…
          </div>
        </>
      )}
      {state === 'error' && (
        <div className="stock-video-state stock-video-state--error" role="alert">
          <p>{error ?? 'Native video discovery failed.'}</p>
          <button type="button" onClick={() => setReloadToken((token) => token + 1)}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && videos.length === 0 && (
        <div className="stock-video-state" role="status">
          No native videos match “{query.trim()}” in {categoryLabel}.
        </div>
      )}
      {state === 'ready' && videos.length > 0 && (
        <ul
          className={`stock-video-grid stock-video-grid--${viewMode}`}
          aria-label={`${categoryLabel} stock videos`}
        >
          {videos.map((video) => (
            <StockVideoCard
              key={video.id}
              video={video}
              client={client}
              importing={importing === video.id}
              failed={failedImports.has(video.id)}
              onPreview={(opener) => void openPreview(video, opener)}
              onImport={() => void importVideo(video)}
            />
          ))}
        </ul>
      )}
      {preview !== undefined && (
        <div
          className="stock-video-preview"
          role="dialog"
          aria-modal="true"
          aria-labelledby="stock-video-preview-title"
        >
          <div className="stock-video-preview-head">
            <strong id="stock-video-preview-title">{preview.video.title}</strong>
            <button
              ref={previewCloseRef}
              type="button"
              aria-label="Close stock video preview"
              onClick={closePreview}
            >
              ×
            </button>
          </div>
          <video
            ref={previewVideoConsumerRef}
            src={preview.url}
            poster={preview.posterUrl}
            controls
            autoPlay
            playsInline
          />
        </div>
      )}
    </section>
  );
}

function StockVideoCard({
  video,
  client,
  importing,
  failed,
  onPreview,
  onImport,
}: {
  readonly video: BrowserStockVideo;
  readonly client: BrowserControlPlaneClient;
  readonly importing: boolean;
  readonly failed: boolean;
  readonly onPreview: (opener: HTMLButtonElement) => void;
  readonly onImport: () => void;
}) {
  const posterTargetRef = useRef<HTMLButtonElement>(null);
  const [posterUrl, setPosterUrl] = useState<string | undefined>();
  const pendingPosterOwner = usePendingObjectUrlOwner();
  const posterRef = useReleasableObjectUrl<HTMLImageElement>(
    posterUrl,
    undefined,
    revokeDetachedObjectUrl,
    pendingPosterOwner,
  );
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const loadPoster = () => {
      void client
        .stockVideoPoster(video.id)
        .then((blob) => {
          if (cancelled) return;
          const url = pendingPosterOwner.track(URL.createObjectURL(blob));
          setPosterUrl(url);
        })
        .catch(() => {
          if (!cancelled) setPosterFailed(true);
        });
    };
    const target = posterTargetRef.current;
    let observer: IntersectionObserver | undefined;
    if (target === null || typeof IntersectionObserver === 'undefined') {
      loadPoster();
    } else {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        loadPoster();
      });
      observer.observe(target);
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
      pendingPosterOwner.revokePending();
    };
  }, [client, pendingPosterOwner, video.id]);
  return (
    <li
      className="stock-video-card"
      data-stock-video-id={video.id}
      data-orientation={video.orientation}
    >
      <button
        ref={posterTargetRef}
        type="button"
        className="stock-video-poster"
        onClick={(event) => onPreview(event.currentTarget)}
        aria-label={`Preview ${video.title}`}
      >
        {posterUrl !== undefined ? (
          <img ref={posterRef} src={posterUrl} alt="" loading="lazy" />
        ) : (
          <span aria-hidden="true">{posterFailed ? 'Poster unavailable' : 'Loading poster…'}</span>
        )}
        <span className="stock-video-orientation">{video.orientation}</span>
      </button>
      <div className="stock-video-card-copy">
        <strong title={video.title}>{video.title}</strong>
        <span className="stock-video-provenance" title={`${video.provider} · ${video.creator}`}>
          {video.provider} · {video.creator}
        </span>
        <span className="stock-video-meta">
          {formatDuration(video.durationUs)} · {video.width}×{video.height}
        </span>
      </div>
      <div className="stock-video-card-actions">
        <a
          href={video.sourcePageUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${video.provider} source for ${video.title}`}
          title={`Open ${video.provider} source for ${video.title}`}
        >
          <ExportIcon />
          <span>Source</span>
        </a>
        <button
          type="button"
          onClick={onImport}
          disabled={importing}
          aria-label={
            importing
              ? `Importing ${video.title} to My media`
              : `${failed ? 'Retry import' : 'Import'} ${video.title} to My media`
          }
          title={
            importing
              ? `Importing ${video.title} to My media`
              : `${failed ? 'Retry import' : 'Import'} ${video.title} to My media`
          }
        >
          <UploadIcon />
          <span>{importing ? 'Importing…' : failed ? 'Retry import' : 'Import'}</span>
        </button>
      </div>
    </li>
  );
}

function formatDuration(durationUs: number): string {
  return `${(durationUs / 1_000_000).toFixed(1)}s`;
}

export async function waitForStockVideoImport(
  client: Pick<BrowserControlPlaneClient, 'stockVideoImportStatus'>,
  projectId: string,
  importId: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let current = await client.stockVideoImportStatus(projectId, importId);
  for (let attempt = 0; attempt < IMPORT_POLL_LIMIT; attempt += 1) {
    if (current.state === 'completed' || current.state === 'failed') return current;
    await wait(IMPORT_POLL_INTERVAL_MS);
    current = await client.stockVideoImportStatus(projectId, importId);
  }
  throw new Error('Stock video import is still processing; try again shortly.');
}
