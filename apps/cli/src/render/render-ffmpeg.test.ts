import { describe, expect, it } from 'vitest';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from '../cli.js';
import { createDefaultProject } from '../utils/project-loader.js';
import { createTextClip } from './text-clip.js';
import { resolveTextFont } from './text-font.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { shell: false }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { shell: false }).status === 0;

describe('CLI ffmpeg render', () => {
  it.skipIf(!resolveTextFont())(
    'removes private text files when ffmpeg fails to start',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'joy-render-text-failure-'));
      const projectPath = join(dir, 'text-project.json');
      const outDir = join(dir, 'out');
      const project = createDefaultProject('Text render failure', { width: 320, height: 240 });
      const root = project.compositions.root!;
      (root as { durationUs: number }).durationUs = 1_000_000;
      const text = createTextClip({
        id: 'failure-caption',
        text: "it's 50%",
        startUs: 0,
        durationUs: 1_000_000,
      });
      (project.captionDocuments as Record<string, unknown>)[text.document.id] = text.document;
      (root.tracks as unknown as Array<Record<string, unknown>>).push({
        id: 'captions',
        kind: 'caption',
        family: 'visual',
        name: 'Captions',
        order: 3,
        enabled: true,
        locked: false,
        clips: [text.clip],
      });
      writeFileSync(projectPath, JSON.stringify(project));
      const previousFfmpeg = process.env.JOY_FFMPEG;
      const before = readdirSync(tmpdir()).filter((name) => name.startsWith('joy-media-text-'));
      process.env.JOY_FFMPEG = join(dir, 'missing ffmpeg executable');
      try {
        expect(
          await runCli(['render', '--project', projectPath, '--preset', 'mp4', '--out', outDir]),
        ).toBe(1);
      } finally {
        if (previousFfmpeg === undefined) delete process.env.JOY_FFMPEG;
        else process.env.JOY_FFMPEG = previousFfmpeg;
        const after = readdirSync(tmpdir()).filter((name) => name.startsWith('joy-media-text-'));
        expect(after).toEqual(before);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasFfmpeg || !hasFfprobe || !resolveTextFont())(
    'renders timed text instead of reporting it applied without output',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'joy-render-text-'));
      try {
        const projectPath = join(dir, 'text-project.json');
        const outDir = join(dir, 'out');
        const fontPath = join(dir, "font 'path,semi;[x].ttf");
        copyFileSync(resolveTextFont()!, fontPath);
        const project = createDefaultProject('Text render', { width: 320, height: 240, fps: 25 });
        const root = project.compositions.root!;
        (root as { durationUs: number }).durationUs = 1_000_000;
        const text = createTextClip({
          id: 'integration-title',
          text: "it's 50%: a,b;[c] x'\\:textfile=/tmp/dt/secret.txt\\:y='5",
          startUs: 0,
          durationUs: 1_000_000,
          size: 48,
          color: '#ffffff',
        });
        (project.captionDocuments as Record<string, unknown>)[text.document.id] = text.document;
        (root.tracks as unknown as Array<Record<string, unknown>>).push({
          id: 'captions',
          kind: 'caption',
          family: 'visual',
          name: 'Captions',
          order: 3,
          enabled: true,
          locked: false,
          clips: [text.clip],
        });
        writeFileSync(projectPath, JSON.stringify(project));
        const previousFont = process.env.JOY_FONT;
        process.env.JOY_FONT = fontPath;
        try {
          expect(
            await runCli(['render', '--project', projectPath, '--preset', 'mp4', '--out', outDir]),
          ).toBe(0);
        } finally {
          if (previousFont === undefined) delete process.env.JOY_FONT;
          else process.env.JOY_FONT = previousFont;
        }
        const output = join(outDir, `${project.id}.mp4`);
        const frame = spawnSync(
          'ffmpeg',
          [
            '-v',
            'error',
            '-ss',
            '0.5',
            '-i',
            output,
            '-frames:v',
            '1',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            'pipe:1',
          ],
          { shell: false, encoding: 'buffer' },
        );
        expect(frame.status).toBe(0);
        const pixels = frame.stdout as Buffer;
        const distinct = new Set(pixels).size;
        expect(distinct).toBeGreaterThan(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasFfmpeg || !hasFfprobe)(
    'renders imported clips at project resolution and verifies output',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'joy-render-integration-'));
      try {
        const first = join(dir, 'first.mp4');
        const second = join(dir, 'second.mp4');
        const audio = join(dir, 'tone.wav');
        const projectPath = join(dir, 'project.json');
        const outDir = join(dir, 'out');
        for (const args of [
          [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=320x240:rate=25:duration=1',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:duration=1',
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-pix_fmt',
            'yuv420p',
            '-c:v',
            'libx264',
            '-c:a',
            'aac',
            '-shortest',
            first,
          ],
          [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=640x360:rate=25:duration=1',
            '-pix_fmt',
            'yuv420p',
            '-c:v',
            'libx264',
            '-an',
            second,
          ],
          ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', audio],
        ])
          expect(spawnSync('ffmpeg', args, { shell: false }).status).toBe(0);
        const project = createDefaultProject('ffmpeg integration', {
          width: 640,
          height: 360,
          fps: 25,
        });
        writeFileSync(projectPath, JSON.stringify(project));
        for (const [path, id] of [
          [first, 'first'],
          [second, 'second'],
          [audio, 'tone'],
        ] as const) {
          expect(
            await runCli(['asset', 'import', path, '--project', projectPath, '--id', id]),
          ).toBe(0);
        }
        const importedProject = JSON.parse(readFileSync(projectPath, 'utf8')).project;
        expect(importedProject.assets.first.hasAudio).toBe(true);
        expect(
          await runCli([
            'timeline',
            'add-clip',
            '--project',
            projectPath,
            '--track',
            'track-v1',
            '--asset',
            'first',
          ]),
        ).toBe(0);
        expect(
          await runCli([
            'timeline',
            'add-clip',
            '--project',
            projectPath,
            '--track',
            'track-v2',
            '--asset',
            'second',
            '--start',
            '1',
          ]),
        ).toBe(0);
        expect(
          await runCli([
            'timeline',
            'add-clip',
            '--project',
            projectPath,
            '--track',
            'track-a1',
            '--asset',
            'tone',
          ]),
        ).toBe(0);
        expect(
          await runCli(['render', '--project', projectPath, '--preset', 'mp4', '--out', outDir]),
        ).toBe(0);
        const output = join(outDir, `${project.id}.mp4`);
        const probe = spawnSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_type,codec_name,width,height:format=duration',
            '-of',
            'json',
            output,
          ],
          { shell: false, encoding: 'utf8' },
        );
        expect(probe.status).toBe(0);
        const metadata = JSON.parse(probe.stdout);
        const video = metadata.streams.find(
          (stream: { codec_type: string }) => stream.codec_type === 'video',
        );
        const sound = metadata.streams.find(
          (stream: { codec_type: string }) => stream.codec_type === 'audio',
        );
        expect(video).toMatchObject({ width: 640, height: 360, codec_name: 'h264' });
        expect(sound!.codec_name).toBe('aac');
        expect(Number(metadata.format.duration)).toBeCloseTo(2, 1);
        const volume = spawnSync(
          'ffmpeg',
          ['-i', output, '-af', 'volumedetect', '-f', 'null', '-'],
          { shell: false, encoding: 'utf8' },
        );
        expect(volume.status).toBe(0);
        const meanVolume = /mean_volume: ([-0-9.]+) dB/.exec(volume.stderr)?.[1];
        expect(Number(meanVolume)).toBeGreaterThan(-60);
        const frame = spawnSync(
          'ffmpeg',
          [
            '-v',
            'error',
            '-ss',
            '0.5',
            '-i',
            output,
            '-frames:v',
            '1',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            'pipe:1',
          ],
          { shell: false, encoding: 'buffer' },
        );
        expect(frame.status).toBe(0);
        const pixels = frame.stdout as Buffer;
        const mean = pixels.reduce((sum, value) => sum + value, 0) / Math.max(pixels.length, 1);
        expect(mean).toBeGreaterThan(10);
        const manifest = JSON.parse(readFileSync(`${output}.manifest.json`, 'utf8'));
        expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(manifest.width).toBe(640);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
