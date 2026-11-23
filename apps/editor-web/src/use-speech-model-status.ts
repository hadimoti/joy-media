import { useEffect, useState } from 'react';
import type { SpeechModelStatus } from './SpeechGenerationPanel.js';

/** How often the engine status is read again. The call is a local lookup of what the worker last reported. */
export const SPEECH_STATUS_POLL_MS = 4_000;

export interface SpeechStatusSource {
  speechStatus(): Promise<{ readonly models: readonly SpeechModelStatus[] }>;
}

/**
 * The local speech engines and whether each is ready. The Worker reports what it can run a few seconds after the
 * app starts, so a single read at project open sees "setup required" for every engine and never changes. Read it
 * again on a timer: an engine that becomes ready shows up without a restart, and one that goes away disappears.
 * A failed read keeps the last known state instead of flashing every engine back to "setup required".
 */
export function useSpeechModelStatus(
  source: SpeechStatusSource,
  resetKey: unknown,
  pollMs: number = SPEECH_STATUS_POLL_MS,
): readonly SpeechModelStatus[] {
  const [models, setModels] = useState<readonly SpeechModelStatus[]>([]);
  useEffect(() => {
    let active = true;
    let warned = false;
    let latestRequest = 0;
    let latestApplied = 0;
    const read = (): void => {
      const request = ++latestRequest;
      let pending: ReturnType<SpeechStatusSource['speechStatus']>;
      try {
        pending = source.speechStatus();
      } catch (error) {
        pending = Promise.reject(error);
      }
      void pending.then(
        (result) => {
          // A slow earlier read must not overwrite what a later read already showed.
          if (!active || request < latestApplied) return;
          latestApplied = request;
          setModels(result.models);
        },
        (error: unknown) => {
          // Keep what is shown; the next tick tries again. Say so once, so a status that never arrives is findable.
          if (!warned) {
            warned = true;
            console.warn('Speech engine status could not be read; retrying.', error);
          }
        },
      );
    };
    read();
    const timer = setInterval(read, pollMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // The source object is stable for the app's lifetime; only a new project restarts the polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, pollMs]);
  return models;
}
