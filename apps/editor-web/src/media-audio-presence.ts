/**
 * Browser-only audio presence check for MP4 and QuickTime files, read from container metadata.
 *
 * Only box headers and the `moov` box are read, so a multi-gigabyte file costs a few small reads
 * and nothing is decoded. Every answer the reader cannot prove is `unknown`. Only a fully parsed
 * `moov` with at least one track, none of them a sound track, is `absent`.
 */

export type AudioPresenceResult =
  | { readonly status: 'present'; readonly streams: number }
  | { readonly status: 'absent' }
  | { readonly status: 'unknown'; readonly reason: string };

/** A `moov` larger than this is not read; it is reported as unknown rather than loaded. */
export const MAX_MOOV_BYTES = 64 * 1024 * 1024;

const CONTAINER_BOXES: ReadonlySet<string> = new Set(['moov', 'trak', 'mdia']);
const SOUND_HANDLER = 'soun';
const VIDEO_HANDLER = 'vide';

interface BoxHeader {
  readonly type: string;
  readonly payloadStart: number;
  readonly end: number;
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Parses one box header at `offset`, or returns undefined when the header is malformed. */
function parseBoxHeader(view: DataView, offset: number, limit: number): BoxHeader | undefined {
  if (offset + 8 > limit) return undefined;
  let size = view.getUint32(offset);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return undefined;
    size = Number(view.getBigUint64(offset + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerSize || offset + size > limit) return undefined;
  return { type: fourcc(view, offset + 4), payloadStart: offset + headerSize, end: offset + size };
}

/** Counts `hdlr` boxes of one handler type under a `moov` payload, through trak/mdia containers. */
function countTracks(
  view: DataView,
  start: number,
  end: number,
): { sound: number; tracks: number } {
  let sound = 0;
  let tracks = 0;
  let offset = start;
  while (offset < end) {
    const box = parseBoxHeader(view, offset, end);
    if (box === undefined) break;
    if (CONTAINER_BOXES.has(box.type)) {
      const nested = countTracks(view, box.payloadStart, box.end);
      sound += nested.sound;
      tracks += nested.tracks;
    } else if (box.type === 'hdlr' && box.payloadStart + 12 <= box.end) {
      // hdlr payload: version and flags (4), pre_defined (4), handler_type (4).
      const handler = fourcc(view, box.payloadStart + 8);
      if (handler === SOUND_HANDLER) sound += 1;
      if (handler === SOUND_HANDLER || handler === VIDEO_HANDLER) tracks += 1;
    }
    offset = box.end;
  }
  return { sound, tracks };
}

/**
 * Reads the `moov` box of an ISO base media file (MP4, MOV, M4V) and reports whether any sound
 * track is declared. Reads: the top-level box headers, then the `moov` payload.
 */
export async function inspectMp4AudioPresence(blob: Blob): Promise<AudioPresenceResult> {
  const head = new DataView(await blob.slice(0, Math.min(blob.size, 16)).arrayBuffer());
  if (head.byteLength < 8 || fourcc(head, 4) !== 'ftyp')
    return { status: 'unknown', reason: 'not an MP4 or QuickTime container' };

  let offset = 0;
  let moov: { readonly start: number; readonly end: number } | undefined;
  while (offset < blob.size && moov === undefined) {
    // Each step reads only the first 16 bytes of one top-level box, then skips its payload.
    const header = new DataView(
      await blob.slice(offset, Math.min(offset + 16, blob.size)).arrayBuffer(),
    );
    // Header offsets are relative to `offset`, and a size of 0 means "to the end of the file".
    const box = parseBoxHeader(header, 0, blob.size - offset);
    if (box === undefined) return { status: 'unknown', reason: 'container box is malformed' };
    if (box.type === 'moov') {
      moov = { start: offset + box.payloadStart, end: offset + box.end };
    } else {
      offset += box.end;
    }
  }
  if (moov === undefined) return { status: 'unknown', reason: 'no movie metadata box was found' };
  if (moov.end - moov.start > MAX_MOOV_BYTES)
    return { status: 'unknown', reason: 'movie metadata is too large to read' };

  const payload = new DataView(await blob.slice(moov.start, moov.end).arrayBuffer());
  const counted = countTracks(payload, 0, payload.byteLength);
  if (counted.tracks === 0) return { status: 'unknown', reason: 'no tracks are declared' };
  return counted.sound > 0 ? { status: 'present', streams: counted.sound } : { status: 'absent' };
}

/** Routes a blob to the reader for its container. Other containers are unknown, never silent. */
export function inspectAudioPresence(blob: Blob, fileName: string): Promise<AudioPresenceResult> {
  if (/\.(mp4|m4v|mov)$/i.test(fileName) || /^video\/(mp4|quicktime)$/i.test(blob.type))
    return inspectMp4AudioPresence(blob);
  return Promise.resolve({ status: 'unknown', reason: 'no metadata reader for this container' });
}
