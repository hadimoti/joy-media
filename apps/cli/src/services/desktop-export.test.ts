import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHistoricalSchemaProjects } from '@joy-media/test-fixtures';
import { buildDesktopProjectEnvelope, writeDesktopProjectExport } from './desktop-export.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(bytes = Buffer.from('original media')) {
  const directory = mkdtempSync(join(tmpdir(), 'joy-desktop-export-'));
  directories.push(directory);
  const mediaPath = join(directory, 'original.bin');
  writeFileSync(mediaPath, bytes);
  const base = buildHistoricalSchemaProjects().v3;
  const id = Object.keys(base.assets)[0] ?? 'asset-video';
  const project = {
    ...base,
    assets: {
      [id]: {
        id,
        kind: 'video' as const,
        displayName: 'original.bin',
        bytes: bytes.byteLength,
        descriptor: { mimeType: 'video/mp4', durationUs: 5_000_000 },
      },
    },
  };
  return { project, sources: { [id]: mediaPath }, id, bytes };
}

describe('desktop project export envelope', () => {
  it('projects the v3 project and embeds verified original media', () => {
    const { project, sources, id, bytes } = fixture();
    const envelope = buildDesktopProjectEnvelope(
      project,
      sources,
      new Date('2026-10-20T00:00:00.000Z'),
    );

    expect(envelope).toMatchObject({
      format: 'joy-media-project',
      schemaVersion: 1,
      app: 'JOY Studio',
      exportedAt: '2026-10-20T00:00:00.000Z',
      source: {
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      documents: {
        visual: { schemaVersion: 1 },
        timeline: { schemaVersion: 0 },
      },
      media: [
        {
          asset: project.assets[id],
          status: 'embedded',
          dataBase64: bytes.toString('base64'),
          byteLength: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mimeType: 'video/mp4',
        },
      ],
    });
  });

  it('refuses a missing original with a stable error code', () => {
    const { project } = fixture();
    expect(() => buildDesktopProjectEnvelope(project, {})).toThrowError(
      expect.objectContaining({ code: 'DESKTOP_EXPORT_MEDIA_MISSING' }),
    );
  });

  it('refuses a title line that would be remapped as an asset id on import', () => {
    const { project, sources, id } = fixture();
    const collidingProject = {
      ...project,
      pluginData: {
        ...project.pluginData,
        'third-party.opaque': {
          title: {
            lines: { primary: id, secondary: '' },
          },
        },
      },
    };

    expect(() => buildDesktopProjectEnvelope(collidingProject, sources)).toThrowError(
      expect.objectContaining({
        code: 'DESKTOP_EXPORT_ASSET_ID_COLLISION',
        message: expect.stringContaining(
          'documents.visual.pluginData.third-party.opaque.title.lines.primary',
        ),
      }),
    );
  });

  it('refuses asset ids inside an opaque namespace named assets', () => {
    const { project, sources, id } = fixture();
    const opaqueProject = {
      ...project,
      pluginData: {
        ...project.pluginData,
        'third-party.opaque': { assets: { note: id } },
      },
    };

    expect(() => buildDesktopProjectEnvelope(opaqueProject, sources)).toThrowError(
      expect.objectContaining({
        code: 'DESKTOP_EXPORT_ASSET_ID_COLLISION',
        message: expect.stringContaining(
          'documents.visual.pluginData.third-party.opaque.assets.note',
        ),
      }),
    );
  });

  it('allows the visual document asset registry while checking other content', () => {
    const { project, sources, id } = fixture();

    const envelope = buildDesktopProjectEnvelope(project, sources);

    expect(envelope.documents.visual.assets).toHaveProperty(id);
  });

  it('refuses an original larger than the 256 MiB package limit', () => {
    const { project, sources, id } = fixture(Buffer.alloc(1));
    const oversizedProject = {
      ...project,
      assets: { [id]: { ...project.assets[id]!, bytes: 256 * 1024 * 1024 + 1 } },
    };
    expect(() => buildDesktopProjectEnvelope(oversizedProject, sources)).toThrowError(
      expect.objectContaining({ code: 'DESKTOP_EXPORT_MEDIA_TOO_LARGE' }),
    );
  });

  it('refuses oversized metadata before opening the small original file', () => {
    const { project, sources, id } = fixture(Buffer.from('small original'));
    const oversizedProject = {
      ...project,
      assets: { [id]: { ...project.assets[id]!, bytes: 256 * 1024 * 1024 + 1 } },
    };
    const readMedia = vi.fn(() => Buffer.alloc(0));

    expect(() =>
      buildDesktopProjectEnvelope(oversizedProject, sources, undefined, undefined, readMedia),
    ).toThrowError(expect.objectContaining({ code: 'DESKTOP_EXPORT_MEDIA_TOO_LARGE' }));
    expect(readMedia).not.toHaveBeenCalled();
  });

  it('refuses corrupt media and preserves an existing output byte-for-byte', async () => {
    const { project, sources, id } = fixture(Buffer.from('verified'));
    writeFileSync(sources[id]!, Buffer.from('corrupt'));
    const output = join(directories.at(-1)!, 'project.joy');
    const previous = Buffer.from('previous complete package');
    writeFileSync(output, previous);

    await expect(writeDesktopProjectExport(project, sources, output)).rejects.toThrowError(
      expect.objectContaining({ code: 'DESKTOP_EXPORT_MEDIA_CORRUPT' }),
    );
    expect(readFileSync(output)).toEqual(previous);
  });

  it('atomically writes a complete desktop envelope to the requested path', async () => {
    const { project, sources } = fixture();
    const output = join(directories.at(-1)!, 'project.joy');

    await writeDesktopProjectExport(project, sources, output, new Date('2026-10-20T00:00:00.000Z'));

    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      format: 'joy-media-project',
      app: 'JOY Studio',
      exportedAt: '2026-10-20T00:00:00.000Z',
    });
  });
});
