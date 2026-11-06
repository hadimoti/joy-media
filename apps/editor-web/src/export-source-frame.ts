import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import {
  abortable,
  abortIfCancelled,
  frameTimesOf,
  frameTimingOf,
  timestampToleranceUs,
  type SeekFrameTiming,
} from './export-seek-target.js';

/**
 * Frame length, timestamp tolerance and stored frame times of the first video track in
 * `sourceUrl`. Resolves `undefined` when the frame length is unknown, so the caller keeps seeking
 * to the exact source time. Throws an AbortError when `signal` aborts, so a cancelled export does
 * not carry on with missing timing. Lives with the forward decoder so mediabunny stays in its
 * lazily loaded chunk.
 */
export async function readSourceFrameTiming(
  sourceUrl: string,
  signal: AbortSignal,
): Promise<SeekFrameTiming | undefined> {
  let blob: Blob;
  try {
    const response = await fetch(sourceUrl, { signal });
    if (!response.ok) {
      abortIfCancelled(signal);
      return undefined;
    }
    blob = await response.blob();
  } catch (error) {
    // A cancelled export stops here; any other failure keeps the exact-time seeks.
    abortIfCancelled(signal);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return undefined;
  }
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await abortable(input.getPrimaryVideoTrack(), signal);
    if (track === null) return undefined;
    // A track that cannot report its resolution keeps its frame length with no tolerance, which is
    // the exact lookup the seeks used before.
    const timeResolution = await abortable(
      track.getTimeResolution().catch(() => 0),
      signal,
    );
    // Awaited here: the input is disposed in `finally`, which would cancel these reads.
    const timing = await frameTimingOf(track, timestampToleranceUs(timeResolution), signal);
    abortIfCancelled(signal);
    if (timing === undefined) return undefined;
    const storedFrameUs = await frameTimesOf(
      () => new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true }),
      timeResolution,
      signal,
    );
    abortIfCancelled(signal);
    return storedFrameUs === undefined ? timing : { ...timing, storedFrameUs };
  } catch (error) {
    // A cancelled export wins over whatever error the cancelled read produced.
    abortIfCancelled(signal);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return undefined;
  } finally {
    input.dispose();
  }
}

/**
 * `readSourceFrameTiming` with its own time limit, for the seek path. A timing read that stalls
 * past `timeoutMs` gives up, and the clip keeps the nominal seeks it used before. A cancelled export
 * still throws an AbortError.
 */
export async function readSourceFrameTimingWithin(
  sourceUrl: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SeekFrameTiming | undefined> {
  const stage = new AbortController();
  const cancel = () => stage.abort();
  // A signal that is already aborted must stop the read too, not only a later abort.
  if (signal.aborted) stage.abort();
  else signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    const timing = await readSourceFrameTiming(sourceUrl, stage.signal);
    // Cancelled after the read finished: hand back no timing.
    abortIfCancelled(signal);
    return timing;
  } catch (error) {
    abortIfCancelled(signal);
    // Our own time limit ended the read: no timing, so nominal seeks.
    if (stage.signal.aborted) return undefined;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
