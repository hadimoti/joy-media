import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultProject } from '../utils/project-loader.js';
import { buildFfmpegFramePlan, buildFfmpegRenderPlan } from './ffmpeg-plan.js';
import { createTextClip, wrapDrawtextDirection } from './text-clip.js';
import { resolveTextFont } from './text-font.js';
import { latinOnlySyntheticFont } from './font-cmap-test-util.js';
import {
  ffmpegCaptionFontSize,
  ffmpegCaptionX,
  ffmpegCaptionY,
  layoutFfmpegCaption,
} from './caption-layout.js';

describe('buildFfmpegRenderPlan', () => {
  it('builds a bounded still-image output from the render composition graph', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-ffmpeg-frame-plan-'));
    try {
      const mediaPath = join(dir, 'clip.mp4');
      writeFileSync(mediaPath, 'plan-only placeholder');
      const project = createDefaultProject('frame plan', { width: 1920, height: 1080, fps: 30 });
      (project.assets as Record<string, unknown>)['asset-1'] = {
        id: 'asset-1',
        kind: 'video',
        displayName: 'clip.mp4',
        localSource: { path: mediaPath },
      };
      (project.compositions.root!.tracks[0]!.clips as unknown[]).push({
        id: 'clip-1',
        kind: 'video',
        assetId: 'asset-1',
        startUs: 0,
        durationUs: 1_000_000,
        sourceInUs: 250_000,
      });
      const plan = buildFfmpegFramePlan(project, 500_000, 512);
      expect(plan.args).toContain('-ss');
      expect(plan.args).toContain('0.5');
      expect(plan.args).toContain('-frames:v');
      expect(plan.args).toContain('1');
      expect(plan.args).not.toContain('-vf');
      expect(plan.args.join(' ')).toContain(
        'scale=512:512:force_original_aspect_ratio=decrease[frame]',
      );
      expect(plan.args).toContain('[frame]');
      expect(plan.args).toContain('image2pipe');
      expect(plan.args).toContain('mjpeg');
      expect(plan.args.join(' ')).toContain('trim=start=0.25');
      expect(plan.args.join(' ')).not.toContain('[aout]');
      expect(plan.inputs).toHaveLength(1);
      expect(plan.width).toBe(512);
      expect(plan.height).toBe(288);
      expect(() => buildFfmpegFramePlan(project, 500_000, 1025)).toThrow(RangeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses project dimensions and rational fps and skips unimported media', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-ffmpeg-plan-'));
    const mediaPath = join(dir, 'clip.mp4');
    writeFileSync(mediaPath, 'plan-only placeholder');
    const project = createDefaultProject('render plan', { width: 1920, height: 1080, fps: 30 });
    const root = project.compositions.root!;
    (root as { frameRate: { num: number; den: number } }).frameRate = { num: 30000, den: 1001 };
    (project.assets as Record<string, unknown>)['asset-1'] = {
      id: 'asset-1',
      kind: 'video',
      displayName: 'clip.mp4',
      localSource: { path: mediaPath },
    };
    (root.tracks[0]!.clips as unknown[]).push({
      id: 'clip-1',
      kind: 'video',
      assetId: 'asset-1',
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 250_000,
    });
    (root.tracks[0]!.clips as unknown[]).push({
      id: 'clip-unimported',
      kind: 'video',
      assetId: 'missing',
      startUs: 1_000_000,
      durationUs: 1_000_000,
      sourceInUs: 0,
    });
    const plan = buildFfmpegRenderPlan(project, 'mp4');
    expect(plan.width).toBe(1920);
    expect(plan.height).toBe(1080);
    expect(plan.args.join(' ')).toContain('s=1920x1080');
    expect(plan.args.join(' ')).toContain('r=30000/1001');
    expect(plan.args.join(' ')).not.toContain('1080x1920');
    expect(plan.skipped).toContainEqual({
      clipId: 'clip-unimported',
      reason: 'asset has no localSource path',
    });
    expect(plan.args.join(' ')).toContain('trim=start=0.25');
    rmSync(dir, { recursive: true, force: true });
  });

  it('maps the base video through the filtergraph when every visual clip is skipped', () => {
    const project = createDefaultProject('all visual clips skipped');
    (project.compositions.root!.tracks[0]!.clips as unknown[]).push({
      id: 'unimported-video',
      kind: 'video',
      assetId: 'missing',
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    });

    const plan = buildFfmpegRenderPlan(project, 'mp4');
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
    const mapIndex = plan.args.indexOf('-map');

    expect(graph).toContain('[0:v]null[vout]');
    expect(plan.args[mapIndex + 1]).toBe('[vout]');
  });

  it('renders validated clip looks into the video chain and skips unknown effects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-ffmpeg-look-plan-'));
    const mediaPath = join(dir, 'clip.mp4');
    writeFileSync(mediaPath, 'plan-only placeholder');
    try {
      const project = createDefaultProject('looks');
      (project.assets as Record<string, unknown>)['asset-look'] = {
        id: 'asset-look',
        kind: 'video',
        displayName: 'clip.mp4',
        localSource: { path: mediaPath },
      };
      const clips = project.compositions.root!.tracks[0]!.clips as unknown as Array<
        Record<string, unknown>
      >;
      clips.push({
        id: 'crt',
        kind: 'video',
        assetId: 'asset-look',
        startUs: 0,
        durationUs: 1_000_000,
        sourceInUs: 0,
        look: { preset: 'crt', intensity: 0.7 },
      });
      clips.push({
        id: 'bw',
        kind: 'video',
        assetId: 'asset-look',
        startUs: 1_000_000,
        durationUs: 1_000_000,
        sourceInUs: 0,
        look: { preset: 'bw', intensity: 0.6 },
      });
      clips.push({
        id: 'warm',
        kind: 'video',
        assetId: 'asset-look',
        startUs: 2_000_000,
        durationUs: 1_000_000,
        sourceInUs: 0,
        look: { preset: 'warm' },
      });
      clips.push({
        id: 'cool',
        kind: 'video',
        assetId: 'asset-look',
        startUs: 3_000_000,
        durationUs: 1_000_000,
        sourceInUs: 0,
        look: { preset: 'cool' },
      });
      clips.push({
        id: 'unknown',
        kind: 'video',
        assetId: 'asset-look',
        startUs: 4_000_000,
        durationUs: 1_000_000,
        sourceInUs: 0,
        look: { preset: 'bad-look' },
      });
      clips.push({
        id: 'unsupported-effect',
        kind: 'video',
        assetId: 'asset-look',
        startUs: 5_000_000,
        durationUs: 1_000_000,
        sourceInUs: 0,
        effects: [{ effectId: 'made-up' }],
      });
      const plan = buildFfmpegRenderPlan(project, 'mp4');
      const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
      expect(graph).toContain('rgbashift');
      expect(graph).toContain('vignette');
      expect(graph).toContain('noise');
      expect(graph).toContain('hue=s=0');
      expect(graph.match(/colorbalance=/g)).toHaveLength(2);
      expect(plan.skipped).toContainEqual(expect.objectContaining({ clipId: 'unknown' }));
      expect(plan.skipped).toContainEqual(
        expect.objectContaining({ clipId: 'unsupported-effect' }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps caption text out of the filtergraph and returns it as a text file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-ffmpeg-caption-plan-'));
    try {
      const project = createDefaultProject('caption plan');
      const content = "it's 50%: a,b;[c] x'\\:textfile=/tmp/dt/secret.txt\\:y='5";
      const text = createTextClip({
        id: 'caption-1',
        text: content,
        startUs: 0,
        durationUs: 1_000_000,
      });
      (project.captionDocuments as Record<string, unknown>)[text.document.id] = text.document;
      (project.compositions.root!.tracks[0]!.clips as unknown[]).push(text.clip);
      const plan = buildFfmpegRenderPlan(
        project,
        'webm',
        { width: 640, height: 360, fps: 25 },
        dir,
      );
      expect(plan.width).toBe(640);
      expect(plan.height).toBe(360);
      expect(plan.fpsExpr).toBe('25/1');
      expect(plan.args.join(' ')).toContain('drawtext=fontfile=');
      const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
      expect(graph).not.toContain(content);
      expect(graph).not.toContain('secret.txt');
      expect(graph).toContain('expansion=none');
      expect(plan.textFiles).toEqual([
        { path: join(dir, 'joy-text-0.txt'), content: wrapDrawtextDirection(content, 'ltr') },
      ]);
      expect(plan.skipped).not.toContainEqual(
        expect.objectContaining({ clipId: 'text-caption-1' }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!resolveTextFont())(
    'uses captions-core pixel geometry in the generated FFmpeg drawtext filter',
    () => {
      for (const example of [
        { width: 1920, height: 1080, x: 0, y: 0, size: 1 },
        { width: 1280, height: 720, x: -0.25, y: 0.2, size: 1.5 },
        { width: 640, height: 360, x: 0.4, y: -0.4, size: 0.75 },
      ]) {
        const dir = mkdtempSync(join(tmpdir(), 'joy-ffmpeg-caption-parity-'));
        try {
          const project = createDefaultProject('caption renderer parity', {
            width: example.width,
            height: example.height,
          });
          const text = createTextClip({
            id: 'caption-parity',
            text: 'Joy title',
            startUs: 0,
            durationUs: 1_000_000,
            x: example.x,
            y: example.y,
            size: example.size,
          });
          (project.captionDocuments as Record<string, unknown>)[text.document.id] = text.document;
          (project.compositions.root!.tracks[0]!.clips as unknown[]).push(text.clip);
          const layout = layoutFfmpegCaption({
            clipId: text.clip.id,
            document: text.document,
            segment: text.document.segments[0]!,
            style: text.clip.style,
            width: example.width,
            height: example.height,
          })[0]!;
          const plan = buildFfmpegRenderPlan(
            project,
            'mp4',
            {
              font: resolveTextFont()!,
              textCapabilities: { textShaping: false, textShapingOption: false },
            },
            dir,
          );
          const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
          expect(graph).toContain(
            `:x=${ffmpegCaptionX(layout)}:y=${ffmpegCaptionY(layout, example.height)}:fontsize=${ffmpegCaptionFontSize(layout)}:`,
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );

  it('skips text with uncovered glyphs and reports the clip, code point, and font', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-ffmpeg-font-coverage-'));
    const fontPath = join(dir, 'latin-only.ttf');
    const oldFont = process.env.JOY_FONT;
    try {
      writeFileSync(fontPath, latinOnlySyntheticFont());
      process.env.JOY_FONT = fontPath;
      const project = createDefaultProject('Persian font coverage');
      const text = createTextClip({
        id: 'persian-coverage',
        text: 'سلام دنیا ۱۲۳',
        startUs: 0,
        durationUs: 1_000_000,
      });
      (project.captionDocuments as Record<string, unknown>)[text.document.id] = text.document;
      (project.compositions.root!.tracks[0]!.clips as unknown[]).push(text.clip);
      const plan = buildFfmpegRenderPlan(project, 'mp4', {}, dir);
      expect(plan.skipped).toEqual([
        expect.objectContaining({
          clipId: text.clip.id,
          reason: expect.stringContaining('U+0633'),
        }),
      ]);
      expect(plan.skipped[0]!.reason).toContain(fontPath);
    } finally {
      if (oldFont === undefined) delete process.env.JOY_FONT;
      else process.env.JOY_FONT = oldFont;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns and degrades rendering of legacy CLI pixel-unit captions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-ffmpeg-legacy-text-'));
    try {
      const project = createDefaultProject('legacy text');
      const text = createTextClip({
        id: 'legacy-text',
        text: 'Old pixel text',
        startUs: 0,
        durationUs: 1_000_000,
      });
      (project.captionDocuments as Record<string, unknown>)[text.document.id] = text.document;
      (project.compositions.root!.tracks[0]!.clips as unknown[]).push({
        ...text.clip,
        style: { ...text.clip.style, fontSize: 64, positionX: 100, positionY: 80 },
      });

      const plan = buildFfmpegRenderPlan(project, 'mp4', {}, dir);

      expect(plan.skipped).toEqual([
        expect.objectContaining({
          clipId: text.clip.id,
          reason: expect.stringContaining('legacy CLI pixel-unit caption style detected'),
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!resolveTextFont('سلام'))(
    'passes text_shaping when the ffmpeg probe reports its drawtext option',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'joy-ffmpeg-shaping-plan-'));
      try {
        const project = createDefaultProject('shaping plan');
        const text = createTextClip({
          id: 'shaping-text',
          text: 'سلام دنیا ۱۲۳',
          startUs: 0,
          durationUs: 1_000_000,
        });
        (project.captionDocuments as Record<string, unknown>)[text.document.id] = text.document;
        (project.compositions.root!.tracks[0]!.clips as unknown[]).push(text.clip);
        const plan = buildFfmpegRenderPlan(
          project,
          'mp4',
          {
            font: resolveTextFont()!,
            textCapabilities: { textShaping: true, textShapingOption: true },
          },
          dir,
        );
        const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
        expect(graph).toContain('text_shaping=1');
        expect(plan.textFiles[0]?.content).toBe(wrapDrawtextDirection('سلام دنیا ۱۲۳', 'rtl'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!resolveTextFont())(
    'rejects non-finite caption positions and unvalidated colors',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'joy-ffmpeg-caption-style-'));
      try {
        const project = createDefaultProject('invalid caption style');
        const text = createTextClip({
          id: 'invalid-style',
          text: 'safe content',
          startUs: 0,
          durationUs: 1_000_000,
        });
        (project.captionDocuments as Record<string, unknown>)[text.document.id] = text.document;
        const invalidClip = {
          ...text.clip,
          style: { ...text.clip.style, positionX: Number.NaN },
        };
        (project.compositions.root!.tracks[0]!.clips as unknown[]).push(invalidClip);
        expect(() => buildFfmpegRenderPlan(project, 'mp4', {}, dir)).toThrow(RangeError);

        const colorProject = createDefaultProject('invalid caption color');
        (colorProject.captionDocuments as Record<string, unknown>)[text.document.id] =
          text.document;
        (colorProject.compositions.root!.tracks[0]!.clips as unknown[]).push({
          ...text.clip,
          style: { ...text.clip.style, textColor: 'red:drawtext=text=unsafe' },
        });
        expect(() => buildFfmpegRenderPlan(colorProject, 'mp4', {}, dir)).toThrow(RangeError);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('mixes embedded audio from unmuted video-track clips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-ffmpeg-video-audio-plan-'));
    try {
      const mediaPath = join(dir, 'clip-with-audio.mp4');
      writeFileSync(mediaPath, 'plan-only placeholder');
      const project = createDefaultProject('video clip with audio');
      (project.assets as Record<string, unknown>)['asset-1'] = {
        id: 'asset-1',
        kind: 'video',
        displayName: 'clip-with-audio.mp4',
        hasAudio: true,
        localSource: { path: mediaPath },
      };
      (project.compositions.root!.tracks[0]!.clips as unknown[]).push({
        id: 'video-with-audio',
        kind: 'video',
        assetId: 'asset-1',
        startUs: 500_000,
        durationUs: 2_000_000,
        sourceInUs: 250_000,
        playbackRate: 1.5,
      });
      const plan = buildFfmpegRenderPlan(project, 'mp4');
      const graph = plan.args.join(' ');
      expect(graph).toContain('[1:a]atrim=start=0.25:duration=3');
      expect(graph).toContain('asetpts=PTS-STARTPTS,atempo=1.5,adelay=500|500[a_0]');
      expect(graph).toContain('[a_0]amix=inputs=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
