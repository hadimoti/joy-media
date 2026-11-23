// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechModelStatus } from './SpeechGenerationPanel.js';
import { useSpeechModelStatus, type SpeechStatusSource } from './use-speech-model-status.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETUP: readonly SpeechModelStatus[] = [
  { modelId: 'kokoro-82m', state: 'setup-required', reasonCode: 'SETUP_REQUIRED' },
];
const READY: readonly SpeechModelStatus[] = [{ modelId: 'kokoro-82m', state: 'ready' }];

describe('useSpeechModelStatus', () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: readonly SpeechModelStatus[] = [];

  function Probe({ source, resetKey }: { source: SpeechStatusSource; resetKey: string }) {
    seen = useSpeechModelStatus(source, resetKey, 1_000);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    root = createRoot(container);
    seen = [];
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('picks up an engine that becomes ready after the first read (the Worker reports late)', async () => {
    const speechStatus = vi
      .fn<SpeechStatusSource['speechStatus']>()
      .mockResolvedValueOnce({ models: SETUP })
      .mockResolvedValue({ models: READY });
    await act(async () => root.render(<Probe source={{ speechStatus }} resetKey="p1" />));
    expect(seen).toEqual(SETUP);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(seen).toEqual(READY);
  });

  it('keeps the last known state when a read fails instead of flashing back to setup required', async () => {
    const speechStatus = vi
      .fn<SpeechStatusSource['speechStatus']>()
      .mockResolvedValueOnce({ models: READY })
      .mockRejectedValue(new Error('bridge unavailable'));
    await act(async () => root.render(<Probe source={{ speechStatus }} resetKey="p1" />));
    expect(seen).toEqual(READY);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(seen).toEqual(READY);
  });

  it('does not let a slow earlier read overwrite a newer one', async () => {
    const resolvers: Array<(value: { models: readonly SpeechModelStatus[] }) => void> = [];
    const speechStatus = vi
      .fn<SpeechStatusSource['speechStatus']>()
      .mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    await act(async () => root.render(<Probe source={{ speechStatus }} resetKey="p1" />));
    // Read 1 is still in flight when the next tick starts read 2.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(resolvers).toHaveLength(2);
    // The newer read answers first: ready. Then the older read answers late: setup required.
    await act(async () => resolvers[1]!({ models: READY }));
    expect(seen).toEqual(READY);
    await act(async () => resolvers[0]!({ models: SETUP }));
    expect(seen).toEqual(READY);
  });

  it('stops polling and ignores a late answer after unmount', async () => {
    let resolveRead: (value: { models: readonly SpeechModelStatus[] }) => void = () => {};
    const speechStatus = vi
      .fn<SpeechStatusSource['speechStatus']>()
      .mockImplementation(() => new Promise((resolve) => (resolveRead = resolve)));
    await act(async () => root.render(<Probe source={{ speechStatus }} resetKey="p1" />));
    const callsBefore = speechStatus.mock.calls.length;
    act(() => root.unmount());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(speechStatus.mock.calls.length).toBe(callsBefore);
    resolveRead({ models: READY });
    root = createRoot(container);
  });
});
