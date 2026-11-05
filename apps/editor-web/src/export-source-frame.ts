import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

/**
 * Duration of one frame of the first video track in `sourceUrl`, from its packet rate. Resolves
 * `undefined` when the rate is unknown, so the caller keeps seeking to the exact source time.
 * Lives with the forward decoder so mediabunny stays in its lazily loaded chunk.
 */
export async function readSourceFrameDurationUs(
  sourceUrl: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  let blob: Blob;
  try {
    const response = await fetch(sourceUrl, { signal });
    if (!response.ok) return undefined;
    blob = await response.blob();
  } catch (error) {
    // A cancelled export stops here; any other failure keeps the exact-time seeks.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return undefined;
  }
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track === null) return undefined;
    const stats = await track.computePacketStats(600);
    return stats.averagePacketRate > 0 ? 1_000_000 / stats.averagePacketRate : undefined;
  } catch {
    return undefined;
  } finally {
    input.dispose();
  }
}
