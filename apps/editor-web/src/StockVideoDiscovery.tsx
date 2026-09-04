import { useEffect, useRef, useState } from 'react';
import {
  STOCK_VIDEO_CATEGORIES,
  type BrowserStockVideo,
  type BrowserStockVideoCategory,
  type BrowserControlPlaneClient,
} from './control-plane-client.js';
import type { AssetViewMode } from './asset-library-state.js';

const STOCK_VIDEO_PAGE_SIZE = 6;
const IMPORT_POLL_INTERVAL_MS = 750;
const IMPORT_POLL_LIMIT = 80;

export function StockVideoDiscovery({
  client,
  projectId: _projectId,
  query,
  viewMode,
  onImport,
  onStatus,
}: {
  readonly client: BrowserControlPlaneClient;
  readonly projectId: string;
  readonly query: string;
  readonly viewMode: AssetViewMode;
  readonly onImport: (video: BrowserStockVideo) => Promise<void>;
  readonly onStatus: (status: string | undefined) => void;
}) {
  const [category, setCategory] = useState<BrowserStockVideoCategory>(STOCK_VIDEO_CATEGORIES[0].id);
  const [videos, setVideos] = useState<readonly BrowserStockVideo[]>([]);
  const [counts, setCounts] = useState<Readonly<Record<BrowserStockVideoCategory, number>>>(
    () =>
      Object.fromEntries(
        STOCK_VIDEO_CATEGORIES.map(({ id }) => [id, STOCK_VIDEO_PAGE_SIZE]),
      ) as Record<BrowserStockVideoCategory, number>,
  );
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
        // Keep the six-card target visible for categories that have not been
        // queried yet; replace only the category backed by this response.
        setCounts((current) => ({ ...current, [category]: page.counts[category] }));
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
  }, [category, client, onStatus, query, reloadToken]);

  useEffect(() => {
    return () => {
      if (preview !== undefined) URL.revokeObjectURL(preview.url);
      if (preview?.posterUrl !== undefined) URL.revokeObjectURL(preview.posterUrl);
    };
  }, [preview]);

  const openPreview = async (video: BrowserStockVideo): Promise<void> => {
    if (preview !== undefined) {
      URL.revokeObjectURL(preview.url);
      if (preview.posterUrl !== undefined) URL.revokeObjectURL(preview.posterUrl);
      setPreview(undefined);
    }
    try {
      const [previewBlob, posterBlob] = await Promise.all([
        client.stockVideoPreview(video.id),
        client.stockVideoPoster(video.id).catch(() => undefined),
      ]);
      const next = {
        video,
        url: URL.createObjectURL(previewBlob),
        ...(posterBlob === undefined ? {} : { posterUrl: URL.createObjectURL(posterBlob) }),
      };
      setPreview(next);
      onStatus(`Preview ready for ${video.title}.`);
    } catch (reason: unknown) {
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

  return (
    <section className="stock-video-discovery" aria-label="Native JOY stock videos">
      <div className="stock-video-heading">
        <div>
          <strong>JOY stock videos</strong>
          <span>Curated clips for your next edit</span>
        </div>
        <span
          className="stock-video-count"
          aria-label={`${counts[category]} clips in this category`}
        >
          {counts[category]} clips
        </span>
      </div>
      <div className="stock-video-categories" role="tablist" aria-label="Stock video categories">
        {STOCK_VIDEO_CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={category === entry.id}
            aria-label={`${entry.label}, ${counts[entry.id]} clips`}
            tabIndex={category === entry.id ? 0 : -1}
            onClick={() => setCategory(entry.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const current = STOCK_VIDEO_CATEGORIES.findIndex((item) => item.id === category);
              const offset = event.key === 'ArrowRight' ? 1 : -1;
              const next =
                STOCK_VIDEO_CATEGORIES[
                  (current + offset + STOCK_VIDEO_CATEGORIES.length) % STOCK_VIDEO_CATEGORIES.length
                ]!;
              setCategory(next.id);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(`[data-stock-category="${next.id}"]`)
                ?.focus();
            }}
            data-stock-category={entry.id}
          >
            <span>{entry.label}</span>
            <small>{counts[entry.id]}</small>
          </button>
        ))}
      </div>
      {state === 'loading' && (
        <div className="stock-video-state" role="status" aria-live="polite">
          Loading native JOY videos…
        </div>
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
          No native videos match “{query.trim()}” in{' '}
          {STOCK_VIDEO_CATEGORIES.find((item) => item.id === category)?.label}.
        </div>
      )}
      {videos.length > 0 && (
        <ul
          className={`stock-video-grid stock-video-grid--${viewMode}`}
          aria-label={`${STOCK_VIDEO_CATEGORIES.find((item) => item.id === category)?.label} stock videos`}
        >
          {videos.map((video) => (
            <StockVideoCard
              key={video.id}
              video={video}
              client={client}
              importing={importing === video.id}
              failed={failedImports.has(video.id)}
              onPreview={() => void openPreview(video)}
              onImport={() => void importVideo(video)}
            />
          ))}
        </ul>
      )}
      {preview !== undefined && (
        <div
          className="stock-video-preview"
          role="dialog"
          aria-label={`Preview ${preview.video.title}`}
        >
          <div className="stock-video-preview-head">
            <strong>{preview.video.title}</strong>
            <button
              type="button"
              aria-label="Close stock video preview"
              onClick={() => {
                URL.revokeObjectURL(preview.url);
                if (preview.posterUrl !== undefined) URL.revokeObjectURL(preview.posterUrl);
                setPreview(undefined);
              }}
            >
              ×
            </button>
          </div>
          <video src={preview.url} poster={preview.posterUrl} controls autoPlay playsInline />
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
  readonly onPreview: () => void;
  readonly onImport: () => void;
}) {
  const posterTargetRef = useRef<HTMLButtonElement>(null);
  const [posterUrl, setPosterUrl] = useState<string | undefined>();
  const posterUrlRef = useRef<string | undefined>(undefined);
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const loadPoster = () => {
      void client
        .stockVideoPoster(video.id)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          posterUrlRef.current = url;
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
      if (posterUrlRef.current !== undefined) {
        URL.revokeObjectURL(posterUrlRef.current);
        posterUrlRef.current = undefined;
      }
    };
  }, [client, video.id]);
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
        onClick={onPreview}
        aria-label={`Preview ${video.title}`}
      >
        {posterUrl !== undefined ? (
          <img src={posterUrl} alt="" loading="lazy" />
        ) : (
          <span aria-hidden>{posterFailed ? 'Poster unavailable' : 'Loading poster…'}</span>
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
        <div className="stock-video-card-actions">
          <a
            href={video.sourcePageUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${video.provider} source for ${video.title}`}
          >
            Source
          </a>
          <button
            type="button"
            onClick={onImport}
            disabled={importing}
            aria-label={`Import ${video.title} to My media`}
          >
            {importing ? 'Importing…' : failed ? 'Retry import' : 'Import to My media'}
          </button>
        </div>
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
