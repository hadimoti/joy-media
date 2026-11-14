import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listTransitionShaders } from '@joy-media/transition-shaders';
import {
  TRANSITION_STRIP_FRAME_COUNT,
  TRANSITION_STRIP_FRAME_HEIGHT,
  TRANSITION_STRIP_FRAME_WIDTH,
  transitionStripFileId,
  transitionStripUrl,
} from './transition-preview-url.js';

interface ManifestTransition {
  readonly id: string;
  readonly safeId: string;
  readonly frameCount: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
}

const manifest = JSON.parse(
  readFileSync(new URL('../../../tooling/previews/manifest.json', import.meta.url), 'utf8'),
) as { readonly transitions: readonly ManifestTransition[] };

describe('transition preview strips', () => {
  // Asks git for the committed file list, so a sparse checkout that leaves the
  // images off disk still checks the real tree. Bytes are read when the file is on disk.
  it('has a committed WebP strip file for every catalogue transition', () => {
    const dir = new URL('../public/transitions/preview/', import.meta.url);
    const committed = new Set(
      execFileSync('git', ['ls-files', '--', 'transitions/preview'], {
        cwd: fileURLToPath(new URL('../public/', import.meta.url)),
        encoding: 'utf8',
      })
        .split(/\r?\n/)
        .filter((line) => line !== ''),
    );
    for (const entry of listTransitionShaders()) {
      const name = `${transitionStripFileId(entry.id)}.webp`;
      expect(committed.has(`transitions/preview/${name}`), `missing strip for ${entry.id}`).toBe(
        true,
      );
      const file = new URL(name, dir);
      if (!existsSync(file)) continue;
      const head = readFileSync(file).subarray(0, 12);
      expect(head.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(head.subarray(8, 12).toString('ascii')).toBe('WEBP');
    }
  });

  it('agrees with the T-V02 manifest on file names and the 24-frame geometry', () => {
    const catalogueIds = listTransitionShaders().map((entry) => entry.id);
    expect(manifest.transitions.map((entry) => entry.id).sort()).toEqual([...catalogueIds].sort());
    for (const entry of manifest.transitions) {
      expect(transitionStripFileId(entry.id)).toBe(entry.safeId);
      expect(entry.frameCount).toBe(TRANSITION_STRIP_FRAME_COUNT);
      expect(entry.frameWidth).toBe(TRANSITION_STRIP_FRAME_WIDTH);
      expect(entry.frameHeight).toBe(TRANSITION_STRIP_FRAME_HEIGHT);
    }
  });

  it('builds a root-relative strip URL without a colon in the file name', () => {
    expect(transitionStripUrl('gl:fade')).toMatch(/^\/transitions\/preview\/gl-fade\.webp\?v=/);
  });

  it('still ships the two placeholder frames the release gate lists', () => {
    for (const name of ['transition-preview-frame-a.svg', 'transition-preview-frame-b.svg']) {
      const source = readFileSync(new URL(`../public/assets/${name}`, import.meta.url), 'utf8');
      expect(source.startsWith('<svg')).toBe(true);
    }
  });
});
