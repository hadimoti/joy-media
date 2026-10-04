import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultProject } from '../utils/project-loader.js';
import { buildFfmpegRenderPlan } from './ffmpeg-plan.js';

describe('buildFfmpegRenderPlan', () => {
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

  it('skips captions and applies explicit output overrides', () => {
    const project = createDefaultProject('caption plan');
    (project.compositions.root!.tracks[0]!.clips as unknown[]).push({
      id: 'caption-1',
      kind: 'caption',
      captionDocumentId: 'captions',
      startUs: 0,
      durationUs: 1_000_000,
    });
    const plan = buildFfmpegRenderPlan(project, 'webm', { width: 640, height: 360, fps: 25 });
    expect(plan.width).toBe(640);
    expect(plan.height).toBe(360);
    expect(plan.fpsExpr).toBe('25/1');
    expect(plan.skipped).toContainEqual({
      clipId: 'caption-1',
      reason: 'caption clips are not supported by the v1 renderer',
    });
  });
});
