import type {
  CompositionId,
  ProjectDiagnostic,
  TimelineTrackFamily,
  TimelineTrackLabelColor,
  TrackId,
} from './model.js';
import { isTimelineTrackLabelColor } from './model.js';

/**
 * Typed projection of the editor's universal row deck.  The deck is keyed by
 * composition and opaque row id; it is deliberately not a cast of creative
 * TrackV1 rows because those arrays may have different identities.
 */
export interface TimelineTrackDeckRow {
  readonly compositionId: CompositionId;
  readonly trackId: TrackId;
  readonly family: TimelineTrackFamily;
  readonly name: string;
  /** Composition-wide draw order: ascending is audio/bottom to visual/top. */
  readonly order: number;
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly labelColor?: TimelineTrackLabelColor;
}

export interface TimelineTrackDeckDocument {
  readonly schemaVersion: 1;
  readonly rows: readonly TimelineTrackDeckRow[];
}

export function validateTimelineTrackDeckDocument(
  value: unknown,
  path = 'timelineTrackDeck',
): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [{ code: 'TIMELINE_DECK_OBJECT', message: 'must be an object', path }];
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) {
    diagnostics.push({
      code: 'TIMELINE_DECK_VERSION',
      message: 'schemaVersion must be 1',
      path: `${path}.schemaVersion`,
    });
  }
  if (!Array.isArray(candidate.rows)) {
    diagnostics.push({
      code: 'TIMELINE_DECK_ROWS',
      message: 'rows must be an array',
      path: `${path}.rows`,
    });
    return diagnostics;
  }
  const ids = new Set<string>();
  for (const [index, raw] of candidate.rows.entries()) {
    const rowPath = `${path}.rows.${index}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      diagnostics.push({
        code: 'TIMELINE_DECK_ROW_OBJECT',
        message: 'row must be an object',
        path: rowPath,
      });
      continue;
    }
    const row = raw as Record<string, unknown>;
    const key = `${String(row.compositionId)}:${String(row.trackId)}`;
    if (ids.has(key))
      diagnostics.push({
        code: 'TIMELINE_DECK_DUPLICATE_ROW',
        message: `duplicate row ${key}`,
        path: rowPath,
      });
    ids.add(key);
    if (typeof row.compositionId !== 'string' || row.compositionId.length === 0)
      diagnostics.push({
        code: 'TIMELINE_DECK_COMPOSITION_ID',
        message: 'compositionId must be non-empty',
        path: `${rowPath}.compositionId`,
      });
    if (typeof row.trackId !== 'string' || row.trackId.length === 0)
      diagnostics.push({
        code: 'TIMELINE_DECK_TRACK_ID',
        message: 'trackId must be non-empty',
        path: `${rowPath}.trackId`,
      });
    if (row.family !== 'visual' && row.family !== 'audio')
      diagnostics.push({
        code: 'TIMELINE_DECK_FAMILY',
        message: 'family must be visual or audio',
        path: `${rowPath}.family`,
      });
    if (typeof row.name !== 'string' || row.name.length === 0)
      diagnostics.push({
        code: 'TIMELINE_DECK_NAME',
        message: 'name must be non-empty',
        path: `${rowPath}.name`,
      });
    if (typeof row.order !== 'number' || !Number.isSafeInteger(row.order) || row.order < 0)
      diagnostics.push({
        code: 'TIMELINE_DECK_ORDER',
        message: 'order must be a non-negative safe integer',
        path: `${rowPath}.order`,
      });
    if (typeof row.enabled !== 'boolean')
      diagnostics.push({
        code: 'TIMELINE_DECK_ENABLED',
        message: 'enabled must be boolean',
        path: `${rowPath}.enabled`,
      });
    if (typeof row.locked !== 'boolean')
      diagnostics.push({
        code: 'TIMELINE_DECK_LOCKED',
        message: 'locked must be boolean',
        path: `${rowPath}.locked`,
      });
    if (row.labelColor !== undefined && !isTimelineTrackLabelColor(row.labelColor))
      diagnostics.push({
        code: 'TIMELINE_DECK_LABEL_COLOR',
        message: `unsupported label color "${String(row.labelColor)}"`,
        path: `${rowPath}.labelColor`,
      });
  }
  return diagnostics;
}
