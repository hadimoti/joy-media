/* global console */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { CliFlags } from '../cli.js';
import { canonicalJson } from '../services/prepared-edit.js';
import { loadAssetSourcesIfPresent } from '../utils/asset-sources.js';
import {
  CommandFailure,
  emitJson,
  loadProject,
  reportFailure,
  usageFailure,
} from '../utils/project-loader.js';

type QueryKind = 'assets' | 'clips' | 'captions' | 'tracks' | 'titles';
type QueryItem = Record<string, unknown>;

interface CursorPayload {
  readonly v: 1;
  readonly kind: QueryKind;
  readonly offset: number;
  readonly revision: number;
  readonly contentHash: string;
  readonly filters: string;
}

/** Schema versions whose track, clip, asset and caption shapes these queries read. */
const SUPPORTED_SCHEMAS: readonly number[] = [1, 2, 3];
const SUPPORTED_TEXT = 'query supports schema versions 1, 2 and 3.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Case-insensitive match that does not depend on the machine's locale. */
function textMatches(value: string, filter: string | undefined): boolean {
  return filter === undefined || value.toLowerCase().includes(filter.toLowerCase());
}

/** Code-unit order: the same on every machine, and distinct strings never compare equal. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseRange(value: string | undefined): readonly [number, number] | undefined {
  if (value === undefined) return undefined;
  const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(value);
  if (!match)
    throw usageFailure('--range-us must be two nonnegative integer microsecond values: START:END.');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    throw usageFailure('--range-us must have a safe integer END greater than START.');
  }
  return [start, end];
}

function parseCursor(value: string | undefined): CursorPayload | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (
      !isRecord(parsed) ||
      parsed.v !== 1 ||
      !['assets', 'clips', 'captions', 'tracks', 'titles'].includes(String(parsed.kind)) ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0 ||
      !Number.isSafeInteger(parsed.revision) ||
      typeof parsed.contentHash !== 'string' ||
      typeof parsed.filters !== 'string'
    ) {
      throw new Error('invalid cursor fields');
    }
    return parsed as unknown as CursorPayload;
  } catch {
    throw usageFailure('Malformed --cursor token.');
  }
}

/** Every track of every composition, ordered by composition id and then by document order. */
function allTracks(
  project: Record<string, unknown>,
): { compositionId: string; track: Record<string, unknown> }[] {
  const compositions = isRecord(project.compositions) ? project.compositions : {};
  return Object.keys(compositions)
    .sort()
    .flatMap((compositionId) => {
      const composition = compositions[compositionId];
      if (!isRecord(composition) || !Array.isArray(composition.tracks)) return [];
      return composition.tracks.filter(isRecord).map((track) => ({ compositionId, track }));
    });
}

function activeFilters(flags: CliFlags): string {
  const entries: [string, string][] = [];
  if (flags.kind !== undefined) entries.push(['kind', flags.kind]);
  if (flags.unplaced) entries.push(['unplaced', 'true']);
  if (flags.track !== undefined) entries.push(['track', flags.track]);
  if (flags.clip !== undefined) entries.push(['clip', flags.clip]);
  if (flags.text !== undefined) entries.push(['text', flags.text]);
  if (flags.rangeUs !== undefined) entries.push(['range-us', flags.rangeUs]);
  return entries
    .sort(([a], [b]) => compareText(a, b))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('&');
}

function validateOptions(kind: QueryKind | undefined, flags: CliFlags): asserts kind is QueryKind {
  if (kind === undefined)
    throw usageFailure(
      'Usage: joy-media query <assets|clips|captions|tracks|titles> --project <file>.',
    );
  if (flags.project === undefined) throw usageFailure('query requires --project <file>.');
  if (flags.limit !== undefined && (!/^[1-9]\d*$/.test(flags.limit) || Number(flags.limit) > 200)) {
    throw usageFailure('--limit must be an integer from 1 through 200.');
  }
  const accepted: Record<QueryKind, readonly string[]> = {
    assets: ['kind', 'unplaced', 'text'],
    clips: ['kind', 'track', 'clip', 'text', 'range-us'],
    captions: ['track', 'clip', 'text', 'range-us'],
    tracks: ['kind', 'track'],
    titles: ['track', 'clip', 'text'],
  };
  const supplied: [string, unknown][] = [
    ['kind', flags.kind],
    ['unplaced', flags.unplaced ? true : undefined],
    ['track', flags.track],
    ['clip', flags.clip],
    ['text', flags.text],
    ['range-us', flags.rangeUs],
  ];
  for (const [name, value] of supplied) {
    if (value !== undefined && !accepted[kind].includes(name)) {
      throw usageFailure(`--${name} does not apply to query ${kind}.`);
    }
  }
  parseRange(flags.rangeUs);
  parseCursor(flags.cursor);
}

function buildItems(
  kind: QueryKind,
  project: Record<string, unknown>,
  flags: CliFlags,
): QueryItem[] {
  const tracks = allTracks(project);
  const assets = isRecord(project.assets) ? project.assets : {};
  const sourceMap = kind === 'assets' ? loadAssetSourcesIfPresent() : {};
  // A placement is any clip that references the asset, in any composition.
  const placements = new Map<string, number>();
  for (const { track } of tracks) {
    if (!Array.isArray(track.clips)) continue;
    for (const clip of track.clips) {
      if (isRecord(clip) && typeof clip.assetId === 'string') {
        placements.set(clip.assetId, (placements.get(clip.assetId) ?? 0) + 1);
      }
    }
  }

  if (kind === 'assets') {
    return Object.entries(assets)
      .flatMap(([id, value]) => {
        if (!isRecord(value)) return [];
        const placementCount = placements.get(id) ?? 0;
        const mapped = typeof sourceMap[id] === 'string';
        const item = {
          id,
          kind: value.kind,
          durationUs:
            isRecord(value.descriptor) && Number.isSafeInteger(value.descriptor.durationUs)
              ? value.descriptor.durationUs
              : null,
          placementCount,
          placed: placementCount > 0,
          availability: mapped ? (existsSync(sourceMap[id]!) ? 'available' : 'missing') : 'unknown',
          sourceMapped: mapped,
        };
        if (flags.kind !== undefined && item.kind !== flags.kind) return [];
        if (flags.unplaced && placementCount !== 0) return [];
        if (!textMatches(id, flags.text)) return [];
        return [item];
      })
      .sort((a, b) => compareText(String(a.id), String(b.id)));
  }

  if (kind === 'tracks') {
    return tracks.flatMap(({ compositionId, track }) => {
      const family = track.family ?? track.kind;
      const item = {
        compositionId,
        id: track.id,
        name: track.name,
        family,
        enabled: track.enabled,
        clipCount: Array.isArray(track.clips) ? track.clips.length : 0,
      };
      if (flags.kind !== undefined && family !== flags.kind) return [];
      if (flags.track !== undefined && track.id !== flags.track) return [];
      return [item];
    });
  }

  if (kind === 'clips') {
    const [rangeStart, rangeEnd] = parseRange(flags.rangeUs) ?? [undefined, undefined];
    const items: QueryItem[] = [];
    for (const { compositionId, track } of tracks) {
      if (!Array.isArray(track.clips)) continue;
      for (const clip of track.clips) {
        if (!isRecord(clip)) continue;
        const endUs = Number(clip.startUs) + Number(clip.durationUs);
        const assetId = typeof clip.assetId === 'string' ? clip.assetId : null;
        if (flags.track !== undefined && track.id !== flags.track) continue;
        if (flags.clip !== undefined && clip.id !== flags.clip) continue;
        if (flags.kind !== undefined && clip.kind !== flags.kind) continue;
        if (
          flags.text !== undefined &&
          !textMatches(String(clip.id), flags.text) &&
          !textMatches(assetId ?? '', flags.text)
        )
          continue;
        if (rangeStart !== undefined && !(Number(clip.startUs) < rangeEnd! && endUs > rangeStart))
          continue;
        items.push({
          compositionId,
          id: clip.id,
          trackId: track.id,
          kind: clip.kind,
          assetId,
          startUs: clip.startUs,
          durationUs: clip.durationUs,
          sourceInUs: clip.sourceInUs ?? null,
        });
      }
    }
    return items.sort(
      (a, b) =>
        Number(a.startUs) - Number(b.startUs) ||
        compareText(String(a.compositionId), String(b.compositionId)) ||
        compareText(String(a.trackId), String(b.trackId)) ||
        compareText(String(a.id), String(b.id)),
    );
  }

  if (kind === 'titles') {
    const raw = isRecord(project.pluginData)
      ? project.pluginData['joy.contentTemplates']
      : undefined;
    const titleInstances = isRecord(raw) && isRecord(raw.instances) ? raw.instances : {};
    const clipMap = new Map<string, { trackId: string; clip: Record<string, unknown> }>();
    for (const { track } of tracks) {
      if (!Array.isArray(track.clips)) continue;
      for (const clip of track.clips)
        if (isRecord(clip) && typeof clip.id === 'string')
          clipMap.set(clip.id, { trackId: String(track.id), clip });
    }
    return Object.entries(titleInstances)
      .flatMap(([instanceId, value]) => {
        if (!isRecord(value) || !isRecord(value.lines)) return [];
        const clipId = String(value.clipId ?? `clip-${instanceId}`);
        const placed = clipMap.get(clipId);
        if (!placed) return [];
        if (flags.track !== undefined && placed.trackId !== flags.track) return [];
        if (flags.clip !== undefined && clipId !== flags.clip) return [];
        const text = `${instanceId} ${String(value.templateId ?? '')} ${String(value.lines.primary ?? '')} ${String(value.lines.secondary ?? '')}`;
        if (!textMatches(text, flags.text)) return [];
        return [
          {
            instanceId,
            templateId: value.templateId,
            objectId: value.objectId,
            clipId,
            trackId: placed.trackId,
            lines: value.lines,
            direction: value.direction,
            startUs: placed.clip.startUs,
            durationUs: placed.clip.durationUs,
          },
        ];
      })
      .sort((a, b) => compareText(String(a.instanceId), String(b.instanceId)));
  }

  // Caption document times are clip-relative in the v1 schema. The range is compared against the
  // mapped timeline times; the stored times are reported next to them.
  const [rangeStart, rangeEnd] = parseRange(flags.rangeUs) ?? [undefined, undefined];
  const items: QueryItem[] = [];
  for (const { compositionId, track } of tracks) {
    if (!Array.isArray(track.clips)) continue;
    for (const clip of track.clips) {
      if (!isRecord(clip) || clip.kind !== 'caption' || typeof clip.captionDocumentId !== 'string')
        continue;
      const documentId = clip.captionDocumentId;
      const document =
        isRecord(project.captionDocuments) && isRecord(project.captionDocuments[documentId])
          ? project.captionDocuments[documentId]
          : undefined;
      if (!document || !Array.isArray(document.segments)) continue;
      const words: Record<string, unknown> = isRecord(document.words) ? document.words : {};
      const wordText = (wordId: unknown): string => {
        const word = words[String(wordId)];
        return isRecord(word) ? String(word.text ?? '') : '';
      };
      for (const [segmentIndex, segment] of document.segments.entries()) {
        if (!isRecord(segment)) continue;
        const text =
          typeof segment.textOverride === 'string'
            ? segment.textOverride
            : Array.isArray(segment.wordIds)
              ? segment.wordIds.map(wordText).join(' ')
              : '';
        if (flags.track !== undefined && track.id !== flags.track) continue;
        if (flags.clip !== undefined && clip.id !== flags.clip) continue;
        if (!textMatches(text, flags.text)) continue;
        const timelineStartUs = Number(clip.startUs) + Number(segment.startUs);
        const timelineEndUs = Number(clip.startUs) + Number(segment.endUs);
        if (
          rangeStart !== undefined &&
          !(timelineStartUs < rangeEnd! && timelineEndUs > rangeStart)
        )
          continue;
        items.push({
          compositionId,
          trackId: track.id,
          clipId: clip.id,
          documentId,
          segmentIndex,
          text,
          startUs: segment.startUs,
          endUs: segment.endUs,
          timelineStartUs,
          timelineEndUs,
          timeDomain: 'document',
        });
      }
    }
  }
  return items.sort(
    (a, b) =>
      compareText(String(a.compositionId), String(b.compositionId)) ||
      compareText(String(a.trackId), String(b.trackId)) ||
      compareText(String(a.clipId), String(b.clipId)) ||
      compareText(String(a.documentId), String(b.documentId)) ||
      Number(a.segmentIndex) - Number(b.segmentIndex),
  );
}

function humanOutput(
  items: QueryItem[],
  returned: number,
  total: number,
  truncated: boolean,
): void {
  const columns = items.length === 0 ? [] : Object.keys(items[0]!);
  console.log(columns.join('\t'));
  for (const item of items)
    console.log(columns.map((column) => String(item[column] ?? '')).join('\t'));
  console.log(
    `showing ${returned} of ${total}; ${truncated ? 'more pages exist' : 'no more pages'}`,
  );
}

function unsupportedSchema(version: unknown): CommandFailure {
  return new CommandFailure(
    'UNSUPPORTED_SCHEMA',
    `Unsupported project schema version ${String(version)}; ${SUPPORTED_TEXT}`,
  );
}

/** One read of the file. The revision, the content hash and every item come from that read. */
function loadForQuery(
  path: string,
  sqlitePath: string | undefined,
): ReturnType<typeof loadProject> {
  try {
    return loadProject(path, sqlitePath);
  } catch (err) {
    if (err instanceof CommandFailure && err.code === 'PROJECT_SCHEMA_UNSUPPORTED') {
      throw new CommandFailure('UNSUPPORTED_SCHEMA', `${err.message} ${SUPPORTED_TEXT}`);
    }
    throw err;
  }
}

export async function handleQueryCommand(args: string[], flags: CliFlags): Promise<number> {
  const json = Boolean(flags.json);
  try {
    if (args.length > 1)
      throw usageFailure(
        'query accepts exactly one kind: assets, clips, captions, tracks, or titles.',
      );
    const kind = ['assets', 'clips', 'captions', 'tracks', 'titles'].includes(args[0] ?? '')
      ? (args[0] as QueryKind)
      : undefined;
    validateOptions(kind, flags);
    if (!flags.project!.toLowerCase().endsWith('.json'))
      throw usageFailure('query requires a project JSON file with --project <file>.');
    const loaded = loadForQuery(flags.project!, flags.sqlitePath);
    // The gate reads the version the file was stored in. A v0 file is migrated on load, and its
    // migrated copy would otherwise pass as schema 3.
    if (!SUPPORTED_SCHEMAS.includes(loaded.storedSchemaVersion))
      throw unsupportedSchema(loaded.storedSchemaVersion);
    const body = loaded.project as unknown as Record<string, unknown>;
    const schemaVersion = body.schemaVersion;
    // Hashed with the same canonical form the plan commands use, so a query's contentHash equals
    // the baseHash of a plan prepared against the same document.
    const contentHash = `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
    const filters = activeFilters(flags);
    const cursor = parseCursor(flags.cursor);
    if (
      cursor &&
      (cursor.kind !== kind ||
        cursor.revision !== loaded.revision ||
        cursor.contentHash !== contentHash ||
        cursor.filters !== filters)
    ) {
      throw new CommandFailure(
        'QUERY_CURSOR_STALE',
        'The query cursor does not match this project revision, content, kind, or filter set.',
      );
    }
    const all = buildItems(kind, body, flags);
    if (cursor && cursor.offset > all.length)
      throw usageFailure('Malformed --cursor token offset.');
    const limit = flags.limit === undefined ? 50 : Number(flags.limit);
    const offset = cursor?.offset ?? 0;
    const items = all.slice(offset, offset + limit);
    const truncated = offset + items.length < all.length;
    const nextCursor = truncated
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            kind,
            offset: offset + items.length,
            revision: loaded.revision,
            contentHash,
            filters,
          } satisfies CursorPayload),
        ).toString('base64url')
      : null;
    if (json) {
      emitJson({
        schemaVersion: 1,
        projectId: String(body.id),
        storedSchemaVersion: loaded.storedSchemaVersion,
        projectSchemaVersion: schemaVersion,
        revision: loaded.revision,
        contentHash,
        units: { time: 'us' },
        items,
        coverage: { total: all.length, returned: items.length, truncated, nextCursor },
      });
    } else humanOutput(items, items.length, all.length, truncated);
    return 0;
  } catch (err) {
    return reportFailure(err, json, 'query');
  }
}
