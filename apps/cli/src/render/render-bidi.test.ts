import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { createDefaultProject } from '../utils/project-loader.js';
import { createTextClip } from './text-clip.js';
import { probeFfmpegTextCapabilities } from './text-capabilities.js';
import { resolveFfmpegExecutable } from './ffmpeg-run.js';

const ffmpegExecutable = resolveFfmpegExecutable();
const hasFfmpeg = spawnSync(ffmpegExecutable, ['-version'], { shell: false }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { shell: false }).status === 0;
const arabicFontCandidates =
  process.platform === 'win32'
    ? ['C:\\Windows\\Fonts\\tahoma.ttf', 'C:\\Windows\\Fonts\\arial.ttf']
    : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
const hasArabicTestFont = arabicFontCandidates.some((font) => existsSync(font));

describe('CLI ffmpeg bidi render', () => {
  it.skipIf(!hasFfmpeg || !hasFfprobe || !hasArabicTestFont)(
    'keeps Persian words on the right of Latin words for RTL base direction',
    async ({ skip }) => {
      const arabicFont = arabicFontCandidates.find((font) => existsSync(font))!;
      const dir = mkdtempSync(join(tmpdir(), 'joy-render-bidi-order-'));
      const previousArabicFont = process.env.JOY_FONT_ARABIC;
      process.env.JOY_FONT_ARABIC = arabicFont;
      try {
        const projectPath = join(dir, 'bidi-project.json');
        const outDir = join(dir, 'out');
        const project = createDefaultProject('Bidi word order', {
          width: 320,
          height: 240,
          fps: 25,
        });
        const root = project.compositions.root!;
        (root as { durationUs: number }).durationUs = 4_000_000;
        const cases = [
          { id: 'latin', text: 'Joy', startUs: 0 },
          { id: 'persian', text: 'مدیا', startUs: 1_000_000 },
          { id: 'auto-rtl', text: 'مدیا Joy', startUs: 2_000_000 },
          { id: 'explicit-rtl', text: 'Joy مدیا', startUs: 3_000_000, direction: 'rtl' as const },
        ];
        const texts = cases.map((item) => createTextClip({ ...item, durationUs: 1_000_000 }));
        for (const text of texts)
          (project.captionDocuments as Record<string, unknown>)[text.document.id] = text.document;
        (root.tracks as unknown as Array<Record<string, unknown>>).push({
          id: 'bidi-captions',
          kind: 'caption',
          family: 'visual',
          name: 'Bidi captions',
          order: 3,
          enabled: true,
          locked: false,
          clips: texts.map((text) => text.clip),
        });
        writeFileSync(projectPath, JSON.stringify(project));
        const ffmpegExecutable = resolveFfmpegExecutable();
        if (!probeFfmpegTextCapabilities(ffmpegExecutable).textShaping) {
          skip();
          return;
        }
        expect(
          await runCli(['render', '--project', projectPath, '--preset', 'mp4', '--out', outDir]),
        ).toBe(0);

        const inkColumnsAt = (timestamp: string) => {
          const frame = spawnSync(
            ffmpegExecutable,
            [
              '-v',
              'error',
              '-ss',
              timestamp,
              '-i',
              join(outDir, `${project.id}.mp4`),
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
          const columns: number[] = [];
          for (let x = 0; x < 320; x += 1) {
            let ink = false;
            for (let y = 0; y < 240; y += 1) {
              const offset = (y * 320 + x) * 3;
              if (pixels[offset]! > 100 && pixels[offset + 1]! > 100 && pixels[offset + 2]! > 100) {
                ink = true;
                break;
              }
            }
            if (ink) columns.push(x);
          }
          return columns;
        };
        const width = (columns: number[]) => columns.at(-1)! - columns[0]! + 1;
        const latinWidth = width(inkColumnsAt('0.5'));
        const persianWidth = width(inkColumnsAt('1.5'));
        for (const timestamp of ['2.5', '3.5']) {
          const columns = inkColumnsAt(timestamp);
          const gaps = columns.slice(1).map((column, index) => column - columns[index]! - 1);
          const splitIndex = gaps.indexOf(Math.max(...gaps));
          expect(gaps[splitIndex]).toBeGreaterThan(0);
          const leftWidth = columns[splitIndex]! - columns[0]! + 1;
          const rightWidth = columns.at(-1)! - columns[splitIndex + 1]! + 1;
          expect(leftWidth).toBeGreaterThan(latinWidth * 0.8);
          expect(leftWidth).toBeLessThan(latinWidth * 1.2);
          expect(rightWidth).toBeGreaterThan(persianWidth * 0.8);
          expect(rightWidth).toBeLessThan(persianWidth * 1.2);
        }
      } finally {
        if (previousArabicFont === undefined) delete process.env.JOY_FONT_ARABIC;
        else process.env.JOY_FONT_ARABIC = previousArabicFont;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
