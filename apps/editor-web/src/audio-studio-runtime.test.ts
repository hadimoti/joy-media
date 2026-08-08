import { describe, expect, it } from 'vitest';
import {
  AUDIO_MODEL_CATALOG,
  buildAudioWorkflowGraph,
  getDefaultAudioModel,
  summarizeLocalAudioResources,
} from './audio-studio-runtime.js';

describe('audio studio runtime contract', () => {
  it('builds the podcast-quality graph from atomic audio APIs in order', () => {
    const graph = buildAudioWorkflowGraph('podcast-quality');

    expect(graph.nodes.map((node) => node.id)).toEqual([
      'audio.denoise',
      'audio.enhance',
      'audio.eq',
      'audio.compress',
      'audio.limit',
      'audio.normalize',
    ]);
    expect(graph.edges).toEqual([
      { from: 'audio.denoise', to: 'audio.enhance' },
      { from: 'audio.enhance', to: 'audio.eq' },
      { from: 'audio.eq', to: 'audio.compress' },
      { from: 'audio.compress', to: 'audio.limit' },
      { from: 'audio.limit', to: 'audio.normalize' },
    ]);
  });

  it('keeps Qwen3-TTS as the default local model for TTS and voice cloning', () => {
    expect(getDefaultAudioModel('audio.tts')?.id).toBe('qwen3-tts');
    expect(getDefaultAudioModel('audio.clone_voice')?.id).toBe('qwen3-tts');
  });

  it('keeps model cache paths local to the Windows machine', () => {
    for (const model of AUDIO_MODEL_CATALOG) {
      expect(model.localPath).toContain('C:\\Users\\<user>\\JOY\\models');
      expect(model.localPath).not.toContain('/opt/joy-media');
    }
  });

  it('summarizes local worker resources without adding cloud-only compute', () => {
    const summary = summarizeLocalAudioResources([
      'audio.denoise',
      'audio.enhance',
      'audio.eq',
      'audio.normalize',
    ]);

    expect(summary.modelCount).toBe(2);
    expect(summary.ramGb).toBe(4);
    expect(summary.vramGb).toBe(4);
    expect(summary.diskGb).toBeGreaterThan(0);
  });
});
