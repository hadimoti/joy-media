/* global process */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runCli, COMMAND_HELP } from '../cli.js';
import {
  FEATURE_IDS,
  RF_ALPHA,
  RF_AUDIO_BUS_GAIN,
  RF_AUDIO_BUS_MUTE,
  RF_AUDIO_BUS_PAN,
  RF_AUDIO_BUS_ROUTING,
  RF_AUDIO_BUS_SOLO,
  RF_AUDIO_EFFECTS,
  RF_AUDIO_FADE_RANGE,
  RF_AUDIO_GAIN_RANGE,
  RF_AUDIO_PAN,
  RF_AUDIO_SOLO,
  RF_CAPTION_RTL,
  RF_CAPTION_STYLE,
  RF_CAPTION_STYLE_OR_ANIMATION,
  RF_CLIP_COLOR_GRADES,
  RF_COLOR_GRADING,
  RF_DISSOLVE_HANDLE,
  RF_NOT_VIDEO_CLIP,
  RF_PLAYBACK_RATE,
  RF_PROCESSED_AUDIO,
  RF_PROPERTY_ANIMATIONS,
  RF_REVERSE_TIME_REMAP,
  RF_TRACK_MUTE_SOLO,
  RF_TRANSITION_TYPE,
  RF_VISUAL_OBJECTS,
  applyProbes,
  baseFeatureList,
  buildFeatureList,
} from './render-features.js';
import {
  buildCapabilities,
  handleCapabilitiesCommand,
  renderSupportMarkdown,
  type CapabilitiesDocument,
} from './capabilities-cmd.js';
import { planMedia } from './render-media.js';
import type * as MediaProbe from '../utils/media-probe.js';

vi.mock('../utils/media-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MediaProbe>();
  return {
    ...actual,
    probeMedia: (path: string) => ({
      hasVideo: true,
      hasAudio: true,
      hasAlpha: path.endsWith('alpha.mp4'),
      isImage: false,
      durationUs: 1_000_000,
      width: 640,
      height: 360,
      mimeType: 'video/mp4',
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __testDir = dirname(__filename);

function resolveTestPath(...segments: string[]): string {
  return resolve(__testDir, ...segments);
}

function readPackageJsonVersion(): string {
  const pkgPath = resolveTestPath('../../package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? '';
}

function captureStdout(fn: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    chunks.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return fn()
    .then((code) => {
      console.log = originalLog;
      return { code, stdout: chunks.join('\n') + '\n' };
    })
    .catch((err) => {
      console.log = originalLog;
      throw err;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('capabilities command', () => {
  it('returns exit code 0', async () => {
    const code = await runCli(['capabilities']);
    expect(code).toBe(0);
  });

  it('--json parses and has schemaVersion "1"', async () => {
    const { code, stdout } = await captureStdout(() => runCli(['capabilities', '--json']));
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as CapabilitiesDocument;
    expect(doc.schemaVersion).toBe('1');
  });

  it('--json has cli.version equal to package.json version', async () => {
    const { stdout } = await captureStdout(() => runCli(['capabilities', '--json']));
    const doc = JSON.parse(stdout) as CapabilitiesDocument;
    expect(doc.cli.name).toBe('joy-media');
    expect(doc.cli.version).toBe(readPackageJsonVersion());
  });

  it('every COMMAND_HELP key is listed with status available', async () => {
    const { stdout } = await captureStdout(() => runCli(['capabilities', '--json']));
    const doc = JSON.parse(stdout) as CapabilitiesDocument;
    const commandNames = new Set(doc.commands.map((c) => c.name));
    for (const key of Object.keys(COMMAND_HELP)) {
      expect(commandNames.has(key)).toBe(true);
    }
    for (const cmd of doc.commands) {
      expect(cmd.status).toBe('available');
    }
  });

  it('every COMMAND_HELP key is dispatched', async () => {
    // The dispatch switch in cli.ts must have a case for every COMMAND_HELP key.
    const knownHandled = new Set([
      'agent',
      'project',
      'timeline',
      'worker',
      'render',
      'benchmark',
      'capabilities',
      'doctor',
      'help',
      'plan',
      'query',
    ]);
    for (const key of Object.keys(COMMAND_HELP)) {
      expect(knownHandled.has(key)).toBe(true);
    }
  });

  it('refuses --json combined with --markdown', async () => {
    const { code, stdout } = await captureStdout(() =>
      runCli(['capabilities', '--json', '--markdown']),
    );
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ type: 'error', code: 'usage_error' });
  });

  it('refuses --json with --markdown and an extra argument after --markdown', async () => {
    const { code, stdout } = await captureStdout(() =>
      runCli(['capabilities', '--json', '--', '--markdown', 'extra']),
    );
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ type: 'error', code: 'usage_error' });
  });

  it('names an unexpected argument after --markdown when --json is absent', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      const code = await runCli(['capabilities', '--', '--markdown', 'extra']);
      expect(code).toBe(2);
      expect(errors.join('\n')).toContain('"extra"');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses --json with --markdown even when --help follows', async () => {
    const { code, stdout } = await captureStdout(() =>
      runCli(['capabilities', '--json', '--', '--markdown', '--help']),
    );
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ type: 'error', code: 'usage_error' });
  });

  it('captions.drawtext is not "unsupported"', async () => {
    const { stdout } = await captureStdout(() => runCli(['capabilities', '--json']));
    const doc = JSON.parse(stdout) as CapabilitiesDocument;
    const captions = doc.features.find((f) => f.id === 'captions.drawtext');
    expect(captions).toBeDefined();
    expect(captions!.status).not.toBe('unsupported');
  });

  it('transitions.other is "unsupported" with the renderer\'s reason', async () => {
    const { stdout } = await captureStdout(() => runCli(['capabilities', '--json']));
    const doc = JSON.parse(stdout) as CapabilitiesDocument;
    const other = doc.features.find((f) => f.id === 'transitions.other');
    expect(other).toBeDefined();
    expect(other!.status).toBe('unsupported');
    expect(other!.reason).toMatch(/only dissolve/i);
  });

  it('render.alpha-media has a reason matching the renderer', async () => {
    const features = buildFeatureList();
    const alpha = features.find((f) => f.id === 'render.alpha-media');
    expect(alpha).toBeDefined();
    expect(alpha!.status).toBe('unsupported');
    expect(alpha!.reason.toLowerCase()).toContain('alpha');
  });

  it('prints a JSON usage error envelope for unexpected arguments', async () => {
    const { code, stdout } = await captureStdout(() => runCli(['capabilities', 'extra', '--json']));
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ type: 'error', code: 'usage_error' });
  });

  it('renders markdown from the same capability document', async () => {
    const expected = renderSupportMarkdown(buildCapabilities({ probes: false }));
    const { code, stdout } = await captureStdout(() =>
      handleCapabilitiesCommand(['--markdown'], { json: false }),
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(expected.trim());
    for (const id of FEATURE_IDS) expect(stdout).toContain(id);
    expect(expected).not.toContain('setup-required');
    expect(expected).toContain('`color grading \\| clip color grades`');
  });
});

describe('capabilities feature list (buildFeatureList)', () => {
  it('includes every expected feature id', () => {
    const features = buildFeatureList();
    const ids = features.map((f) => f.id);
    expect(ids).toEqual(FEATURE_IDS);
  });

  it('has a reason for every feature', () => {
    const features = buildFeatureList();
    for (const feat of features) {
      expect(feat.reason).toBeTruthy();
      expect(typeof feat.reason).toBe('string');
    }
  });

  it('every feature has a valid status', () => {
    const features = buildFeatureList();
    const valid = new Set(['available', 'setup-required', 'unsupported', 'unknown']);
    for (const feat of features) {
      expect(valid.has(feat.status)).toBe(true);
    }
  });
});

describe('capability executor agreement', () => {
  const fallback = { width: 640, height: 360, fps: 30 };

  function project(
    overrides: Record<string, unknown> = {},
    clips: unknown[] = [],
  ): Record<string, unknown> {
    return {
      rootCompositionId: 'root',
      compositions: { root: { tracks: [{ id: 'track', enabled: true, clips }], transitions: [] } },
      assets: {},
      ...overrides,
    };
  }

  function videoClip(
    assetId = 'clip.mp4',
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: 'clip',
      kind: 'video',
      assetId,
      startUs: 0,
      durationUs: 500_000,
      sourceInUs: 0,
      ...extra,
    };
  }

  it('every unsupported feature refusal matches a planner refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-capabilities-'));
    try {
      for (const name of ['alpha.mp4', 'clip.mp4', 'second.mp4']) {
        writeFileSync(join(dir, name), 'fixture');
      }
      const clipCases: Array<{
        feature: string;
        kind: 'refuse' | 'condition';
        fragments: readonly string[];
        value: Record<string, unknown>;
      }> = [
        {
          feature: 'render.alpha-media',
          kind: 'refuse',
          fragments: [RF_ALPHA],
          value: project({}, [videoClip('alpha.mp4')]),
        },
        {
          feature: 'render.playback-rate',
          kind: 'refuse',
          fragments: [RF_PLAYBACK_RATE],
          value: project({}, [videoClip('clip.mp4', { playbackRate: 2 })]),
        },
        {
          feature: 'render.freeze-frame',
          kind: 'refuse',
          fragments: [RF_PLAYBACK_RATE],
          value: project({}, [videoClip('clip.mp4', { playbackRate: 0 })]),
        },
        {
          feature: 'render.reverse',
          kind: 'refuse',
          fragments: [RF_REVERSE_TIME_REMAP],
          value: project({}, [videoClip('clip.mp4', { reversed: true })]),
        },
        {
          feature: 'render.time-remap',
          kind: 'refuse',
          fragments: [RF_REVERSE_TIME_REMAP],
          value: project({}, [videoClip('clip.mp4', { timeRemap: {} })]),
        },
        {
          feature: 'render.nested-composition',
          kind: 'refuse',
          fragments: [RF_NOT_VIDEO_CLIP],
          value: project({}, [{ id: 'nested', kind: 'composition' }]),
        },
        {
          feature: 'render.visual-objects',
          kind: 'refuse',
          fragments: [RF_VISUAL_OBJECTS],
          value: project({ visualObjects: { visual: {} } }),
        },
        {
          feature: 'render.property-animations',
          kind: 'refuse',
          fragments: [RF_PROPERTY_ANIMATIONS],
          value: project({ propertyAnimations: { animation: {} } }),
        },
        {
          feature: 'render.color-grade',
          kind: 'refuse',
          fragments: [RF_COLOR_GRADING],
          value: project({ colorGrade: {} }),
        },
        {
          feature: 'render.color-grade',
          kind: 'refuse',
          fragments: [RF_CLIP_COLOR_GRADES],
          value: project({ clipColorGrades: { clip: {} } }),
        },
        {
          feature: 'render.audio-effects',
          kind: 'refuse',
          fragments: [RF_AUDIO_EFFECTS],
          value: project({ audio: { effects: [{}] } }),
        },
        {
          feature: 'render.audio-bus-routing',
          kind: 'refuse',
          fragments: [RF_AUDIO_BUS_ROUTING],
          value: project({ audio: { buses: [{}, {}] } }),
        },
        {
          feature: 'render.audio-bus-settings',
          kind: 'refuse',
          fragments: [RF_AUDIO_BUS_GAIN],
          value: project({ audio: { buses: [{ gain: 2 }] } }),
        },
        {
          feature: 'render.audio-bus-settings',
          kind: 'refuse',
          fragments: [RF_AUDIO_BUS_PAN],
          value: project({ audio: { buses: [{ pan: 1 }] } }),
        },
        {
          feature: 'render.audio-bus-settings',
          kind: 'refuse',
          fragments: [RF_AUDIO_BUS_MUTE],
          value: project({ audio: { buses: [{ mute: true }] } }),
        },
        {
          feature: 'render.audio-bus-settings',
          kind: 'refuse',
          fragments: [RF_AUDIO_BUS_SOLO],
          value: project({ audio: { buses: [{ solo: true }] } }),
        },
        {
          feature: 'render.audio-pan',
          kind: 'refuse',
          fragments: [RF_AUDIO_PAN],
          value: project({ audio: { clips: { clip: { pan: 1 } } } }),
        },
        {
          feature: 'render.audio-solo',
          kind: 'refuse',
          fragments: [RF_AUDIO_SOLO],
          value: project({ audio: { clips: { clip: { solo: true } } } }),
        },
        {
          feature: 'render.audio-processed-source',
          kind: 'refuse',
          fragments: [RF_PROCESSED_AUDIO],
          value: project({ audio: { clips: { clip: { sourceAssetId: 'processed' } } } }),
        },
        {
          feature: 'transitions.other',
          kind: 'refuse',
          fragments: [RF_TRANSITION_TYPE],
          value: project({ transitions: [{ type: 'wipe' }] }),
        },
        {
          feature: 'captions.styling',
          kind: 'refuse',
          fragments: [RF_CAPTION_STYLE],
          value: project({}, [{ id: 'caption', kind: 'caption', style: {} }]),
        },
        {
          feature: 'captions.styling',
          kind: 'refuse',
          fragments: [RF_CAPTION_STYLE_OR_ANIMATION],
          value: project({ captionDocuments: { doc: { styleRef: 'style' } } }, [
            { id: 'caption', kind: 'caption', captionDocumentId: 'doc' },
          ]),
        },
        {
          feature: 'captions.rtl',
          kind: 'refuse',
          fragments: [RF_CAPTION_RTL],
          value: project({ captionDocuments: { doc: { direction: 'rtl' } } }, [
            { id: 'caption', kind: 'caption', captionDocumentId: 'doc' },
          ]),
        },
        {
          feature: 'audio.gain',
          kind: 'condition',
          fragments: [RF_AUDIO_GAIN_RANGE],
          value: project({ audio: { clips: { clip: { gain: 5 } } } }),
        },
        {
          feature: 'audio.fades',
          kind: 'condition',
          fragments: [RF_AUDIO_FADE_RANGE],
          value: project({ audio: { clips: { clip: { fadeInUs: -1 } } } }),
        },
      ];
      const catalog = baseFeatureList();
      const messagesByFeature = new Map<string, string[]>();
      for (const item of clipCases) {
        const result = planMedia(item.value, { manifestOnly: false, mediaDir: dir }, fallback);
        expect(result.mode).toBe('error');
        if (result.mode !== 'error') continue;
        expect(result.code).toBe('unsupported-feature');
        for (const fragment of item.fragments) expect(result.message).toContain(fragment);
        const entry = catalog.find((feature) => feature.id === item.feature);
        expect(entry, item.feature).toBeDefined();
        if (item.kind === 'refuse') {
          expect(entry?.status, item.feature).toBe('unsupported');
          for (const fragment of item.fragments) {
            expect(entry?.refusal, item.feature).toContain(fragment);
          }
          const messages = messagesByFeature.get(item.feature) ?? [];
          messages.push(result.message);
          messagesByFeature.set(item.feature, messages);
        } else {
          expect(entry?.status, item.feature).toBe('available');
          for (const fragment of item.fragments) {
            expect(entry?.reason, item.feature).toContain(fragment);
          }
        }
      }
      const trackMuteProject = project({}, [{ id: 'clip', kind: 'video' }]);
      const root = (
        trackMuteProject.compositions as Record<string, { tracks: Array<Record<string, unknown>> }>
      ).root!;
      root.tracks[0]!.muted = true;
      const trackMute = planMedia(trackMuteProject, { manifestOnly: false }, fallback);
      expect(trackMute.mode).toBe('error');
      if (trackMute.mode === 'error') {
        expect(trackMute.code).toBe('unsupported-feature');
        expect(trackMute.message).toContain(RF_TRACK_MUTE_SOLO);
        const feature = 'render.track-mute-solo';
        const entry = catalog.find((candidate) => candidate.id === feature);
        expect(entry, feature).toBeDefined();
        expect(entry?.status, feature).toBe('unsupported');
        expect(entry?.refusal, feature).toContain(RF_TRACK_MUTE_SOLO);
        const messages = messagesByFeature.get(feature) ?? [];
        messages.push(trackMute.message);
        messagesByFeature.set(feature, messages);
      }
      for (const feature of catalog.filter((item) => item.status === 'unsupported')) {
        const messages = messagesByFeature.get(feature.id) ?? [];
        expect(messages.length, feature.id).toBeGreaterThan(0);
        for (const fragment of feature.refusal) {
          expect(messages.some((message) => message.includes(fragment))).toBe(true);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses dissolves when source media has no handles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-dissolve-'));
    try {
      writeFileSync(join(dir, 'clip.mp4'), 'fixture');
      writeFileSync(join(dir, 'second.mp4'), 'fixture');
      const value = project({}, [
        videoClip('clip.mp4', { durationUs: 1_000_000 }),
        { ...videoClip('second.mp4', { durationUs: 1_000_000 }), id: 'second', startUs: 1_000_000 },
      ]);
      (value.compositions as Record<string, { transitions: unknown[] }>).root!.transitions = [
        { type: 'dissolve', durationUs: 200_000, leftClipId: 'clip', rightClipId: 'second' },
      ];
      const result = planMedia(value, { manifestOnly: false, mediaDir: dir }, fallback);
      expect(result.mode).toBe('error');
      if (result.mode === 'error') expect(result.message).toContain(RF_DISSOLVE_HANDLE);
      const dissolve = baseFeatureList().find((feature) => feature.id === 'transitions.dissolve');
      expect(dissolve?.status).toBe('available');
      expect(dissolve?.reason).toContain(RF_DISSOLVE_HANDLE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('capability probe status', () => {
  it('marks every available feature setup-required when ffmpeg is missing', () => {
    const features = baseFeatureList();
    const result = applyProbes(features, { ffmpeg: false, ffprobe: true, captionFont: true });
    for (const input of features) {
      const output = result.find((feature) => feature.id === input.id);
      expect(output, input.id).toBeDefined();
      if (input.status === 'available') {
        expect(output?.status, input.id).toBe('setup-required');
        expect(output?.reason, input.id).toContain('ffmpeg');
        expect(output?.reason, input.id).not.toContain('ffprobe');
      } else if (input.status === 'unsupported') {
        expect(output?.status, input.id).toBe(input.status);
        expect(output?.reason, input.id).toBe(input.reason);
      }
    }
  });

  it('names both missing binaries', () => {
    const features = baseFeatureList();
    const result = applyProbes(features, { ffmpeg: false, ffprobe: false, captionFont: true });
    for (const input of features) {
      const output = result.find((feature) => feature.id === input.id);
      if (input.status === 'available') {
        expect(output?.status, input.id).toBe('setup-required');
        expect(output?.reason, input.id).toContain('ffmpeg');
        expect(output?.reason, input.id).toContain('ffprobe');
      } else {
        expect(output?.status, input.id).toBe(input.status);
        expect(output?.reason, input.id).toBe(input.reason);
      }
    }
  });

  it('keeps the caption font setup reason when the font is missing', () => {
    const captions = baseFeatureList().filter((feature) => feature.id === 'captions.drawtext');
    const result = applyProbes(captions, { ffmpeg: true, ffprobe: true, captionFont: false });
    expect(result[0]?.status).toBe('setup-required');
    expect(result[0]?.reason).toContain('JOY_MEDIA_CAPTION_FONT');
  });

  it('changes only captions.drawtext when only the caption font is missing', () => {
    const features = baseFeatureList();
    const result = applyProbes(features, { ffmpeg: true, ffprobe: true, captionFont: false });
    for (const input of features) {
      const output = result.find((feature) => feature.id === input.id);
      expect(output, input.id).toBeDefined();
      if (input.id === 'captions.drawtext') {
        expect(output?.status).toBe('setup-required');
        expect(output?.reason).toContain('JOY_MEDIA_CAPTION_FONT');
      } else {
        expect(output?.status, input.id).toBe(input.status);
        expect(output?.reason, input.id).toBe(input.reason);
      }
    }
  });
});

describe('CLI-RENDER-SUPPORT.md matches the static capability catalog', () => {
  const docPath = resolveTestPath('../../../../docs/product/CLI-RENDER-SUPPORT.md');

  function tableCells(line: string): string[] {
    return line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, '|'));
  }

  it('has one row per catalog feature, with the same id, status, reason and refusal text', () => {
    const docContent = readFileSync(docPath, 'utf8');
    const rows = docContent.split(/\r?\n/).filter((line) => line.startsWith('| `'));
    const features = baseFeatureList();
    expect(rows).toHaveLength(features.length);

    for (const feature of features) {
      const row = rows.find((line) => tableCells(line)[0] === '`' + feature.id + '`');
      expect(row, feature.id).toBeDefined();
      const refusal = feature.refusal.length > 0 ? '`' + feature.refusal.join(' | ') + '`' : 'none';
      expect(row && tableCells(row), feature.id).toEqual([
        '`' + feature.id + '`',
        feature.status,
        feature.reason,
        refusal,
      ]);
    }
  });

  it('does not claim a setup state', () => {
    const docContent = readFileSync(docPath, 'utf8');
    expect(docContent).not.toContain('setup-required');
  });
});
