/* global process */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';
import { loadProject } from '../utils/project-loader.js';

// A pass-through spy: the real loader runs, and the tests can count how often a query loads.
vi.mock('../utils/project-loader.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, loadProject: vi.fn(actual.loadProject as typeof loadProject) };
});

interface Fixture {
  readonly directory: string;
  readonly home: string;
  readonly database: string;
  readonly projectFile: string;
  readonly envelope: Record<string, any>;
}

const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const directories: string[] = [];

function restoreVariable(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  restoreVariable('HOME', realHome.HOME);
  restoreVariable('USERPROFILE', realHome.USERPROFILE);
});

async function capture(
  fn: () => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const write = process.stdout.write;
  const log = console.log;
  const error = console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '));
  try {
    return { code: await fn(), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    process.stdout.write = write;
    console.log = log;
    console.error = error;
  }
}

async function fixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'joy-query-'));
  directories.push(directory);
  // The asset-source map lives under the home directory. Each fixture gets its own home, so the
  // query reads the real map file and never touches the developer's own state.
  const home = join(directory, 'home');
  mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const database = join(directory, 'projects.sqlite');
  const projectFile = join(directory, 'project.json');
  const created = await capture(() =>
    runCli(['project', 'create', 'Query fixture', '--sqlite-path', database, '--json']),
  );
  const id = JSON.parse(created.stdout).id as string;
  const exported = await capture(() =>
    runCli(['project', 'export', id, '--sqlite-path', database, '--output', projectFile, '--json']),
  );
  expect(exported.code).toBe(0);
  const envelope = JSON.parse(readFileSync(projectFile, 'utf8')) as Record<string, any>;
  return { directory, home, database, projectFile, envelope };
}

function save(f: Fixture): void {
  writeFileSync(f.projectFile, JSON.stringify(f.envelope, null, 2));
}

/** Writes the asset-source map that the query reads from this fixture's home directory. */
function setAssetSources(map: Record<string, string>): void {
  const dir = join(process.env.HOME!, '.joy-media');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cli-asset-sources.json'), JSON.stringify(map));
}

async function query(f: Fixture, kind: string, ...options: string[]) {
  const before = readFileSync(f.projectFile);
  const result = await capture(() =>
    runCli(['query', kind, '--project', f.projectFile, '--json', ...options]),
  );
  expect(readFileSync(f.projectFile)).toEqual(before);
  return result;
}

describe('query command', () => {
  it('lists assets with placement and availability and filters unplaced assets', async () => {
    const f = await fixture();
    const p = f.envelope.source;
    p.assets = {
      used: {
        id: 'used',
        kind: 'video',
        displayName: 'Used',
        descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000 },
      },
      free: { id: 'free', kind: 'image', displayName: 'Free' },
      absent: { id: 'absent', kind: 'audio', displayName: 'Absent' },
    };
    p.compositions.root.tracks[0].clips.push({
      id: 'clip-a',
      kind: 'video',
      assetId: 'used',
      startUs: 0,
      durationUs: 400_000,
      sourceInUs: 0,
    });
    save(f);
    setAssetSources({ absent: join(f.directory, 'not-present.mp4'), used: f.projectFile });
    const before = readFileSync(f.projectFile);
    const listed = await query(f, 'assets');
    expect(JSON.parse(listed.stdout)).toMatchObject({
      storedSchemaVersion: 3,
      projectSchemaVersion: 3,
    });
    const items = JSON.parse(listed.stdout).items;
    expect(items.find((item: any) => item.id === 'used')).toMatchObject({
      placementCount: 1,
      placed: true,
      availability: 'available',
      sourceMapped: true,
    });
    expect(items.find((item: any) => item.id === 'absent').availability).toBe('missing');
    expect(
      JSON.parse((await query(f, 'assets', '--unplaced')).stdout).items.map((item: any) => item.id),
    ).toEqual(['absent', 'free']);
    expect(readFileSync(f.projectFile)).toEqual(before);
  });

  it('paginates with exact totals and rejects a stale revision cursor', async () => {
    const f = await fixture();
    f.envelope.source.assets = Object.fromEntries(
      ['a', 'b', 'c'].map((id) => [id, { id, kind: 'image', displayName: id }]),
    );
    save(f);
    const before = readFileSync(f.projectFile);
    const first = JSON.parse((await query(f, 'assets', '--limit', '2')).stdout);
    expect(first.coverage).toMatchObject({ total: 3, returned: 2, truncated: true });
    expect(first.coverage.nextCursor).toBeTruthy();
    const second = JSON.parse(
      (await query(f, 'assets', '--limit', '2', '--cursor', first.coverage.nextCursor)).stdout,
    );
    expect(second.coverage).toMatchObject({
      total: 3,
      returned: 1,
      truncated: false,
      nextCursor: null,
    });
    expect(readFileSync(f.projectFile)).toEqual(before);
    f.envelope.revision += 1;
    save(f);
    const stale = await query(f, 'assets', '--limit', '2', '--cursor', first.coverage.nextCursor);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({ type: 'error', code: 'QUERY_CURSOR_STALE' });
  });

  it('validates limits and filters and returns JSON refusals on stdout', async () => {
    const f = await fixture();
    for (const limit of ['201', '0']) {
      const result = await query(f, 'assets', '--limit', limit);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ type: 'error', code: 'USAGE' });
    }
    expect((await query(f, 'clips', '--unplaced')).code).toBe(2);
    const before = readFileSync(f.projectFile);
    const human = await capture(() => runCli(['query', 'clips', '--project', f.projectFile]));
    expect(human.stdout).toContain('showing');
    expect(readFileSync(f.projectFile)).toEqual(before);
  });

  it('filters clips by overlapping half-open time range', async () => {
    const f = await fixture();
    const tracks = f.envelope.source.compositions.root.tracks;
    tracks[0].clips.push(
      {
        id: 'ends-at-start',
        kind: 'video',
        assetId: 'x',
        startUs: 0,
        durationUs: 10,
        sourceInUs: 0,
      },
      { id: 'overlaps', kind: 'video', assetId: 'x', startUs: 9, durationUs: 4, sourceInUs: 0 },
    );
    save(f);
    expect(
      JSON.parse((await query(f, 'clips', '--range-us', '10:12')).stdout).items.map(
        (item: any) => item.id,
      ),
    ).toEqual(['overlaps']);
  });

  it('returns distinct caption segments by document locator and text', async () => {
    const f = await fixture();
    const p = f.envelope.source;
    p.captionDocuments = Object.fromEntries(
      ['doc-a', 'doc-b'].map((id) => [
        id,
        {
          id,
          language: 'en',
          direction: 'ltr',
          speakers: [],
          words: { w: { id: 'w', text: 'hello there', startUs: 0, endUs: 50 } },
          segments: [{ id: 'same-index', startUs: 0, endUs: 50, wordIds: ['w'] }],
        },
      ]),
    );
    // Caption clips are only valid on caption tracks.
    const captionTrack: any = {
      id: 'track-captions',
      kind: 'caption',
      name: 'Captions',
      enabled: true,
      clips: [],
    };
    p.compositions.root.tracks.push(captionTrack);
    captionTrack.clips.push(
      ...['doc-a', 'doc-b'].map((id, index) => ({
        id: `caption-${index}`,
        kind: 'caption',
        startUs: 0,
        durationUs: 100,
        captionDocumentId: id,
      })),
    );
    save(f);
    const items = JSON.parse((await query(f, 'captions', '--text', 'HELLO')).stdout).items;
    expect(items).toHaveLength(2);
    expect(items.map((item: any) => item.documentId)).toEqual(['doc-a', 'doc-b']);
    expect(items[0]).toMatchObject({ clipId: 'caption-0', timeDomain: 'document' });
  });

  it('maps clip-relative caption times onto the timeline for range queries', async () => {
    const f = await fixture();
    const p = f.envelope.source;
    p.captionDocuments = {
      'doc-r': {
        id: 'doc-r',
        language: 'en',
        direction: 'ltr',
        speakers: [],
        words: { w: { id: 'w', text: 'late cue', startUs: 0, endUs: 50 } },
        segments: [{ id: 'cue', startUs: 0, endUs: 50, wordIds: ['w'] }],
      },
    };
    // Caption clips are only valid on caption tracks.
    const captionTrack: any = {
      id: 'track-timeline-captions',
      kind: 'caption',
      name: 'Captions',
      enabled: true,
      clips: [],
    };
    p.compositions.root.tracks.push(captionTrack);
    captionTrack.clips.push({
      id: 'caption-late',
      kind: 'caption',
      startUs: 1_000,
      durationUs: 100,
      captionDocumentId: 'doc-r',
    });
    save(f);
    const inside = JSON.parse((await query(f, 'captions', '--range-us', '1010:1020')).stdout).items;
    expect(inside.map((item: any) => item.clipId)).toEqual(['caption-late']);
    expect(inside[0]).toMatchObject({
      startUs: 0,
      endUs: 50,
      timelineStartUs: 1_000,
      timelineEndUs: 1_050,
    });
    expect(JSON.parse((await query(f, 'captions', '--range-us', '0:500')).stdout).items).toEqual(
      [],
    );
  });

  it('keeps track document order while filtering by family and reports unsupported schema', async () => {
    const f = await fixture();
    const tracks = f.envelope.source.compositions.root.tracks;
    tracks.reverse();
    save(f);
    expect(
      JSON.parse((await query(f, 'tracks', '--kind', 'visual')).stdout).items.map(
        (item: any) => item.id,
      ),
    ).toEqual(['track-v2', 'track-v1']);
    f.envelope.source.schemaVersion = 4;
    save(f);
    const result = await query(f, 'tracks');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ type: 'error', code: 'UNSUPPORTED_SCHEMA' });
  });

  it('refuses a file stored at schema 0 even though the loader can migrate it', async () => {
    const f = await fixture();
    f.envelope.source = {
      schemaVersion: 0,
      id: f.envelope.source.id,
      rootCompositionId: 'root',
      compositions: {
        root: {
          id: 'root',
          name: 'Legacy',
          width: 1920,
          height: 1080,
          frameRate: { num: 30, den: 1 },
          durationUs: 10_000_000,
          tracks: [{ id: 'track-v1', kind: 'video', order: 0, enabled: true, clips: [] }],
        },
      },
    };
    save(f);
    const result = await query(f, 'tracks');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ type: 'error', code: 'UNSUPPORTED_SCHEMA' });
  });

  it('counts placements and lists tracks and clips in every composition', async () => {
    const f = await fixture();
    const root = f.envelope.source.compositions.root;
    f.envelope.source.assets = {
      used: {
        id: 'used',
        kind: 'video',
        displayName: 'Used',
        descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000 },
      },
    };
    f.envelope.source.compositions.child = {
      ...root,
      id: 'child',
      name: 'Child',
      tracks: [
        {
          id: 'track-child',
          kind: 'video',
          family: 'visual',
          name: 'Child video',
          order: 0,
          enabled: true,
          locked: false,
          clips: [
            {
              id: 'child-clip',
              kind: 'video',
              assetId: 'used',
              sourceInUs: 0,
              startUs: 0,
              durationUs: 100_000,
            },
          ],
        },
      ],
    };
    save(f);
    const assets = JSON.parse((await query(f, 'assets')).stdout).items;
    expect(assets.find((item: any) => item.id === 'used')).toMatchObject({
      placementCount: 1,
      placed: true,
    });
    const tracks = JSON.parse((await query(f, 'tracks')).stdout).items;
    expect(tracks.map((item: any) => [item.compositionId, item.id])).toContainEqual([
      'child',
      'track-child',
    ]);
    const clips = JSON.parse((await query(f, 'clips')).stdout).items;
    expect(clips.map((item: any) => [item.compositionId, item.id])).toEqual([
      ['child', 'child-clip'],
    ]);
  });

  it('orders assets by code unit, so equal-looking ids and member order cannot change pages', async () => {
    const f = await fixture();
    const asset = (id: string) => ({ id, kind: 'image', displayName: id });
    f.envelope.source.assets = {
      é: asset('é'),
      é: asset('é'),
      '10': asset('10'),
      '2': asset('2'),
    };
    save(f);
    const first = JSON.parse((await query(f, 'assets')).stdout);
    expect(first.items.map((item: any) => item.id)).toEqual(['10', '2', 'é', 'é']);
    // The same document with its members written in the opposite order: same identity, same pages.
    f.envelope.source.assets = {
      '2': asset('2'),
      '10': asset('10'),
      é: asset('é'),
      é: asset('é'),
    };
    save(f);
    const second = JSON.parse((await query(f, 'assets')).stdout);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.items.map((item: any) => item.id)).toEqual(
      first.items.map((item: any) => item.id),
    );
  });

  it('reports the content hash that a plan prepared on the same document records as baseHash', async () => {
    const f = await fixture();
    // Integer-like keys are where JSON.stringify and the canonical form disagree.
    f.envelope.source.assets = {
      '2': { id: '2', kind: 'image', displayName: 'two' },
      '10': { id: '10', kind: 'image', displayName: 'ten' },
    };
    save(f);
    const queried = JSON.parse((await query(f, 'tracks')).stdout);
    const operations = join(f.directory, 'operations.json');
    writeFileSync(operations, JSON.stringify({ schemaVersion: 1, operations: [] }));
    const plan = join(f.directory, 'plan.json');
    const prepared = await capture(() =>
      runCli([
        'plan',
        'prepare',
        operations,
        '--project',
        f.projectFile,
        '--output',
        plan,
        '--json',
      ]),
    );
    expect(prepared.code).toBe(0);
    expect(JSON.parse(readFileSync(plan, 'utf8')).baseHash).toBe(queried.contentHash);
  });

  it('loads the project file once per query', async () => {
    const f = await fixture();
    vi.mocked(loadProject).mockClear();
    expect((await query(f, 'assets')).code).toBe(0);
    expect(vi.mocked(loadProject)).toHaveBeenCalledTimes(1);
  });

  it('leaves the CLI state directory uncreated, whichever kind is queried', async () => {
    const f = await fixture();
    const state = join(f.home, '.joy-media');
    rmSync(state, { recursive: true, force: true });
    const before = readdirSync(f.home);
    for (const kind of ['assets', 'clips', 'captions', 'tracks']) {
      expect((await query(f, kind)).code).toBe(0);
    }
    expect(existsSync(state)).toBe(false);
    expect(readdirSync(f.home)).toEqual(before);
  });
});
