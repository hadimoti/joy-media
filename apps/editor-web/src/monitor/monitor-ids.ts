import type { JoyProjectV1 } from '@joy-media/project-schema';
import { readClipObjectMap } from '../sticker-bindings.js';

/**
 * The Monitor's id converters (ADR-0046 section 4.5 and review B3, T-M15).
 * The timeline selects **clip ids**; the document edits **visual object ids**;
 * the drawn frame (`RenderFrameIR`) mixes three kinds of node id:
 *
 * - a visual object id (text, shape, picture, the 3D element),
 * - a timeline clip id (a video clip's picture is keyed by its clip id),
 * - a caption id `caption:<clip id>:<segment id>[:line<n>]` (burned-in captions).
 *
 * Every Monitor module converts through this file and nowhere else.
 */

const CAPTION_PREFIX = 'caption:';
const CAPTION_LINE = /:line(\d+)$/;

/** The parts of a caption node id. */
export interface CaptionNodeIdParts {
  /** The caption clip on the timeline. */
  readonly clipId: string;
  /** The caption segment (cue) inside that clip's document. */
  readonly segmentId: string;
  /** The wrapped line of the cue, when the id names one line. */
  readonly line?: number;
}

/** Clip id to visual object id, or `undefined` when the clip draws no visual object. */
export function clipIdToObjectId(project: JoyProjectV1, clipId: string): string | undefined {
  const objectId = readClipObjectMap(project)[clipId];
  return objectId !== undefined && project.visualObjects[objectId] !== undefined
    ? objectId
    : undefined;
}

/**
 * Visual object id to the clip ids bound to it, in binding order. Pass the
 * timeline's clip ids to keep only clips that exist (the default seed bindings
 * name clips a project may not have).
 */
export function objectIdToClipIds(
  project: JoyProjectV1,
  objectId: string,
  timelineClipIds?: ReadonlySet<string>,
): readonly string[] {
  return Object.entries(readClipObjectMap(project))
    .filter(
      ([clipId, boundObjectId]) =>
        boundObjectId === objectId &&
        (timelineClipIds === undefined || timelineClipIds.has(clipId)),
    )
    .map(([clipId]) => clipId);
}

/** Visual object id to its first bound clip id (what a Monitor click selects). */
export function objectIdToClipId(
  project: JoyProjectV1,
  objectId: string,
  timelineClipIds?: ReadonlySet<string>,
): string | undefined {
  return objectIdToClipIds(project, objectId, timelineClipIds)[0];
}

/** Builds a caption node id the way `@joy-media/captions-core` does. */
export function captionNodeId(clipId: string, segmentId: string, line?: number): string {
  return `${CAPTION_PREFIX}${clipId}:${segmentId}${line === undefined ? '' : `:line${line}`}`;
}

export function isCaptionNodeId(nodeId: string): boolean {
  return nodeId.startsWith(CAPTION_PREFIX);
}

/**
 * Reads a caption node id. The clip id is the part before the first `:`
 * after the prefix (clip ids have no `:`); the rest is the segment id.
 */
export function parseCaptionNodeId(nodeId: string): CaptionNodeIdParts | undefined {
  if (!isCaptionNodeId(nodeId)) return undefined;
  let rest = nodeId.slice(CAPTION_PREFIX.length);
  const lineMatch = CAPTION_LINE.exec(rest);
  const line = lineMatch === null ? undefined : Number(lineMatch[1]);
  if (lineMatch !== null) rest = rest.slice(0, lineMatch.index);
  const split = rest.indexOf(':');
  if (split <= 0 || split === rest.length - 1) return undefined;
  return {
    clipId: rest.slice(0, split),
    segmentId: rest.slice(split + 1),
    ...(line === undefined ? {} : { line }),
  };
}

/**
 * A drawn node id (from `RenderFrameIR` or `nodeBounds`) to the timeline clip
 * the selection should hold: a caption names its clip; a node keyed by a
 * clip id (video) is that clip; a visual object maps back through its binding.
 */
export function renderNodeIdToClipId(
  project: JoyProjectV1,
  nodeId: string,
  timelineClipIds: ReadonlySet<string>,
): string | undefined {
  const caption = parseCaptionNodeId(nodeId);
  if (caption !== undefined)
    return timelineClipIds.has(caption.clipId) ? caption.clipId : undefined;
  if (timelineClipIds.has(nodeId)) return nodeId;
  return objectIdToClipId(project, nodeId, timelineClipIds);
}
