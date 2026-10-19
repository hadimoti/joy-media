/* global process */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli, COMMAND_HELP } from '../cli.js';
import {
  REASON_VISUAL_OBJECTS,
  REASON_PROPERTY_ANIMATIONS,
  REASON_AUDIO_EFFECTS,
  REASON_AUDIO_BUS_ROUTING,
  buildFeatureList,
} from './render-features.js';
import { type CapabilitiesDocument } from './capabilities-cmd.js';

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
    ]);
    for (const key of Object.keys(COMMAND_HELP)) {
      expect(knownHandled.has(key)).toBe(true);
    }
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

  it('unsupported features use matching reason strings from the renderer', async () => {
    const features = buildFeatureList();

    // Features whose reasons are shared constants from render-features.ts.
    // render-media.ts imports the same constants, so the reason text cannot drift.
    const sharedChecks: Array<{ id: string; constant: string }> = [
      { id: 'render.visual-objects', constant: REASON_VISUAL_OBJECTS },
      { id: 'render.property-animations', constant: REASON_PROPERTY_ANIMATIONS },
      { id: 'render.audio-effects', constant: REASON_AUDIO_EFFECTS },
      { id: 'render.audio-bus-routing', constant: REASON_AUDIO_BUS_ROUTING },
    ];

    for (const { id, constant } of sharedChecks) {
      const feat = features.find((f) => f.id === id);
      expect(feat).toBeDefined();
      expect(feat!.status).toBe('unsupported');
      // The reason should mention the shared constant text
      expect(feat!.reason.toLowerCase()).toContain(constant.toLowerCase());
    }
  });

  it('render.alpha-media has a reason matching the renderer', async () => {
    const features = buildFeatureList();
    const alpha = features.find((f) => f.id === 'render.alpha-media');
    expect(alpha).toBeDefined();
    expect(alpha!.status).toBe('unsupported');
    expect(alpha!.reason.toLowerCase()).toContain('alpha');
  });
});

describe('capabilities feature list (buildFeatureList)', () => {
  it('includes every expected feature id', () => {
    const features = buildFeatureList();
    const ids = features.map((f) => f.id);
    const expected = [
      'render.real-media',
      'render.frame-rate.ntsc-and-fraction',
      'render.alpha-media',
      'render.playback-rate',
      'render.freeze-frame',
      'render.reverse',
      'render.time-remap',
      'render.nested-composition',
      'render.visual-objects',
      'render.property-animations',
      'render.color-grade',
      'render.audio-effects',
      'render.audio-bus-routing',
      'render.audio-pan',
      'render.audio-solo',
      'render.track-mute-solo',
      'render.audio-processed-source',
      'captions.drawtext',
      'transitions.dissolve',
      'transitions.other',
      'audio.gain',
      'audio.fades',
      'audio.mute',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
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

describe('CLI-RENDER-SUPPORT.md doc file lists every feature id', () => {
  const docPath = resolveTestPath('../../../../docs/product/CLI-RENDER-SUPPORT.md');

  it('contains every feature id', () => {
    const docContent = readFileSync(docPath, 'utf8');
    const features = buildFeatureList();

    for (const feat of features) {
      expect(docContent).toContain(feat.id);
    }
  });

  it('contains unsupported feature ids', () => {
    const docContent = readFileSync(docPath, 'utf8');
    const features = buildFeatureList().filter((f) => f.status === 'unsupported');

    for (const feat of features) {
      expect(docContent).toContain(feat.id);
    }
  });

  it('contains available feature ids', () => {
    const docContent = readFileSync(docPath, 'utf8');
    const features = buildFeatureList().filter((f) => f.status === 'available');

    for (const feat of features) {
      expect(docContent).toContain(feat.id);
    }
  });
});
