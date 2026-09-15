// @vitest-environment jsdom

import { act, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Focused React lifecycle reproduction for App's ordering: the playback
 * effect is declared before decoder setup, and the media-ready revision must
 * re-run it after fresh decoder refs are installed.
 */
function MediaLifecycleHarness({
  projectRevision,
  onCaptureAttached,
}: {
  readonly projectRevision: number;
  readonly onCaptureAttached: (decoder: string) => void;
}) {
  const decoderRef = useRef<string | null>(null);
  const [mediaReadyRevision, setMediaReadyRevision] = useState(0);

  useEffect(() => {
    const decoder = decoderRef.current;
    if (decoder === null) return;
    onCaptureAttached(decoder);
  }, [mediaReadyRevision, onCaptureAttached, projectRevision]);

  useEffect(() => {
    decoderRef.current = `decoder-${projectRevision}`;
    setMediaReadyRevision((revision) => revision + 1);
    return () => {
      decoderRef.current = null;
    };
  }, [projectRevision]);

  return null;
}

describe('media decoder readiness lifecycle', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('reattaches the capture effect after a project edit replaces the decoder', async () => {
    const captures: string[] = [];
    const onCaptureAttached = (decoder: string) => captures.push(decoder);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MediaLifecycleHarness projectRevision={1} onCaptureAttached={onCaptureAttached} />,
      );
    });
    expect(captures.at(-1)).toBe('decoder-1');

    await act(async () => {
      root.render(
        <MediaLifecycleHarness projectRevision={2} onCaptureAttached={onCaptureAttached} />,
      );
    });
    expect(captures.at(-1)).toBe('decoder-2');

    await act(async () => root.unmount());
  });
});
