import { describe, expect, it } from 'vitest';
import { renderOfflineAudio } from './offline.js';
import type { AudioClipRenderSpec, OfflineRenderConfig } from './offline.js';
import type { AudioBus, AudioClipConfig, AudioEffect } from './graph.js';

describe('offline audio renderer', () => {
  function generateSineWave(
    frequency: number,
    amplitude: number,
    duration: number,
    sampleRate: number,
  ): Float32Array {
    const samples = new Float32Array(sampleRate * duration);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    }
    return samples;
  }

  const defaultClipConfig: AudioClipConfig = {
    gain: 1.0,
    pan: 0,
    mute: false,
    solo: false,
  };

  describe('stereo export', () => {
    const config: OfflineRenderConfig = {
      sampleRate: 1_000_000,
      channels: 2,
      startUs: 0,
      endUs: 4,
    };
    const clip: AudioClipRenderSpec = {
      clipId: 'voice',
      samples: new Float32Array([1, 0, 0, 0]),
      startUs: 0,
      config: defaultClipConfig,
      effects: [],
    };
    it('keeps left/right source content separate at center', () => {
      const result = renderOfflineAudio(
        [
          {
            ...clip,
            channelData: [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])],
          },
        ],
        [],
        config,
      );
      expect(result.channelData[0]![0]).toBeCloseTo(1);
      expect(result.channelData[0]![1]).toBeCloseTo(0);
      expect(result.channelData[1]![0]).toBeCloseTo(0);
      expect(result.channelData[1]![1]).toBeCloseTo(1);
    });
    it('pans mono with equal power and stereo with crossfeed, like Web Audio', () => {
      const center = renderOfflineAudio([clip], [], config);
      expect(center.channelData[0]![0]).toBeCloseTo(Math.SQRT1_2);
      expect(center.channelData[1]![0]).toBeCloseTo(Math.SQRT1_2);
      const result = renderOfflineAudio(
        [
          {
            ...clip,
            config: { ...clip.config, pan: 1 },
            channelData: [clip.samples, new Float32Array(4)],
          },
        ],
        [],
        config,
      );
      expect(result.channelData[0]![0]).toBeCloseTo(0);
      expect(result.channelData[1]![0]).toBeCloseTo(1);
    });
    it('combines bus and clip pan and respects explicit routing, solo and mute', () => {
      const buses: AudioBus[] = [
        { id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] },
        {
          id: 'voice-bus',
          name: 'Voice',
          gain: 0.5,
          pan: -0.5,
          mute: false,
          solo: true,
          inputs: ['voice'],
        },
      ];
      const voice = { ...clip, config: { ...clip.config, pan: -0.5, solo: true } };
      const result = renderOfflineAudio([voice, { ...clip, clipId: 'music' }], buses, config);
      expect(result.channelData[0]![0]).toBeCloseTo(0.5);
      expect(result.channelData[1]![0]).toBeCloseTo(0);
      const muted = renderOfflineAudio(
        [voice],
        buses.map((bus) => ({ ...bus, mute: true })),
        config,
      );
      expect(muted.channelData.every((channel) => channel.every((sample) => sample === 0))).toBe(
        true,
      );
    });
    it('renders clip overlap when the export range starts inside the clip', () => {
      const result = renderOfflineAudio(
        [{ ...clip, samples: new Float32Array([1, 2, 3, 4]), config: { ...clip.config, pan: -1 } }],
        [],
        { ...config, startUs: 2 },
      );
      expect([...result.channelData[0]!]).toEqual([3, 4]);
    });
    it('ramps pan independently in left and right outputs', () => {
      const result = renderOfflineAudio([{ ...clip, samples: new Float32Array(4).fill(1) }], [], {
        ...config,
        automation: {
          blockSize: 4,
          clipAt: (_id, timeUs, fallback) => ({ ...fallback, pan: -1 + timeUs / 2 }),
        },
      });
      expect(result.channelData[0]![0]).toBeCloseTo(1);
      expect(result.channelData[1]![0]).toBeCloseTo(0);
      expect(result.channelData[0]![2]).toBeCloseTo(Math.SQRT1_2);
      expect(result.channelData[1]![2]).toBeCloseTo(Math.SQRT1_2);
    });
  });

  describe('clip placement', () => {
    it('places clip at correct timeline position', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 2_000_000,
      };

      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([1.0, 1.0, 1.0, 1.0]),
        startUs: 1_000_000,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clip], [], config);

      expect(result.samples.length).toBe(sampleRate * 2);
      expect(result.samples[0]).toBe(0);
      expect(result.samples[sampleRate]).toBeCloseTo(1.0, 1);
    });

    it('handles multiple clips at different positions', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 3_000_000,
      };

      const clip1: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([0.5, 0.5]),
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const clip2: AudioClipRenderSpec = {
        clipId: 'clip2',
        samples: new Float32Array([0.3, 0.3]),
        startUs: 1_000_000,
        config: defaultClipConfig,
        effects: [],
      };

      const clip3: AudioClipRenderSpec = {
        clipId: 'clip3',
        samples: new Float32Array([0.2, 0.2]),
        startUs: 2_000_000,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clip1, clip2, clip3], [], config);

      expect(result.samples[0]).toBeCloseTo(0.5, 1);
      expect(result.samples[sampleRate]).toBeCloseTo(0.3, 1);
      expect(result.samples[sampleRate * 2]).toBeCloseTo(0.2, 1);
    });

    it('skips clips outside render range', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 1_000_000,
        endUs: 2_000_000,
      };

      const clipBefore: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([1.0]),
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const clipAfter: AudioClipRenderSpec = {
        clipId: 'clip2',
        samples: new Float32Array([1.0]),
        startUs: 3_000_000,
        config: defaultClipConfig,
        effects: [],
      };

      const clipInside: AudioClipRenderSpec = {
        clipId: 'clip3',
        samples: new Float32Array([0.5]),
        startUs: 1_500_000,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clipBefore, clipAfter, clipInside], [], config);

      expect(result.samples[0]).toBe(0);
      expect(result.samples[sampleRate / 2]).toBeCloseTo(0.5, 1);
    });

    it('skips muted clips', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const mutedClip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([1.0, 1.0]),
        startUs: 0,
        config: { ...defaultClipConfig, mute: true },
        effects: [],
      };

      const result = renderOfflineAudio([mutedClip], [], config);

      expect(result.samples[0]).toBe(0);
      expect(result.samples[1]).toBe(0);
    });
  });

  describe('effect application', () => {
    it('applies clip-level effects', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const samples = generateSineWave(1000, 0.5, 1, sampleRate);
      const eqEffect: AudioEffect = {
        kind: 'eq',
        bands: [{ frequency: 1000, gain: 6, q: 1, type: 'peaking' }],
      };

      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples,
        startUs: 0,
        config: defaultClipConfig,
        effects: [eqEffect],
      };

      const result = renderOfflineAudio([clip], [], config);

      expect(result.peakLevel).toBeGreaterThan(-10);
    });

    it('applies multiple effects in order', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const samples = generateSineWave(1000, 0.5, 1, sampleRate);
      const effects: AudioEffect[] = [
        { kind: 'eq', bands: [{ frequency: 1000, gain: 3, q: 1, type: 'peaking' }] },
        { kind: 'limiter', ceiling: -6, releaseUs: 50000 },
      ];

      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples,
        startUs: 0,
        config: defaultClipConfig,
        effects,
      };

      const result = renderOfflineAudio([clip], [], config);

      expect(result.peakLevel).toBeLessThan(-5);
    });
  });

  describe('clip config application', () => {
    it('applies gain', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([0.5, 0.5]),
        startUs: 0,
        config: { ...defaultClipConfig, gain: 0.5 },
        effects: [],
      };

      const result = renderOfflineAudio([clip], [], config);

      expect(result.samples[0]).toBeCloseTo(0.25, 2);
    });

    it('applies fade-in', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const samples = new Float32Array(100).fill(1.0);
      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples,
        startUs: 0,
        config: { ...defaultClipConfig, fadeInUs: 1_000 },
        effects: [],
      };

      const result = renderOfflineAudio([clip], [], config);

      expect(result.samples[0]).toBeCloseTo(0.0, 2);
      expect(result.samples[24]).toBeCloseTo(0.5, 1);
    });

    it('applies fade-out', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const samples = new Float32Array(100).fill(1.0);
      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples,
        startUs: 0,
        config: { ...defaultClipConfig, fadeOutUs: 50_000 },
        effects: [],
      };

      const result = renderOfflineAudio([clip], [], config);

      expect(result.samples[99]).toBeCloseTo(0.0, 1);
    });
  });

  describe('bus routing', () => {
    it('routes clips through buses', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const buses: AudioBus[] = [
        {
          id: 'bus1',
          name: 'Master',
          gain: 1.0,
          pan: 0,
          mute: false,
          solo: false,
          inputs: [],
        },
      ];

      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([0.5, 0.5]),
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clip], buses, config);

      expect(result.samples[0]).toBeCloseTo(0.5, 1);
    });

    it('applies bus gain', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const buses: AudioBus[] = [
        {
          id: 'bus1',
          name: 'Master',
          gain: 0.5,
          pan: 0,
          mute: false,
          solo: false,
          inputs: [],
        },
      ];

      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([1.0, 1.0]),
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clip], buses, config);

      expect(result.samples[0]).toBeCloseTo(0.5, 1);
    });

    it('skips muted buses', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const buses: AudioBus[] = [
        {
          id: 'bus1',
          name: 'Master',
          gain: 1.0,
          pan: 0,
          mute: true,
          solo: false,
          inputs: [],
        },
      ];

      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([1.0, 1.0]),
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clip], buses, config);

      expect(result.samples[0]).toBeCloseTo(0, 1);
    });
  });

  describe('mixing', () => {
    it('mixes multiple clips correctly', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const clip1: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([0.3, 0.3]),
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const clip2: AudioClipRenderSpec = {
        clipId: 'clip2',
        samples: new Float32Array([0.2, 0.2]),
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clip1, clip2], [], config);

      expect(result.samples[0]).toBeCloseTo(0.5, 1);
    });
  });

  describe('measurements', () => {
    it('measures peak level accurately', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const samples = generateSineWave(1000, 0.5, 1, sampleRate);
      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples,
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clip], [], config);

      expect(result.peakLevel).toBeLessThan(0);
      expect(result.peakLevel).toBeGreaterThan(-10);
    });

    it('measures loudness accurately', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 5_000_000,
      };

      const samples = generateSineWave(1000, 0.5, 5, sampleRate);
      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples,
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clip], [], config);

      expect(result.loudness).toBeLessThan(0);
      expect(result.loudness).toBeGreaterThan(-50);
    });

    it('detects clipping', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([1.5, 1.5]),
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clip], [], config);

      expect(result.clipping).toBe(true);
    });

    it('reports no clipping for normal audio', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 1_000_000,
      };

      const clip: AudioClipRenderSpec = {
        clipId: 'clip1',
        samples: new Float32Array([0.5, 0.5]),
        startUs: 0,
        config: defaultClipConfig,
        effects: [],
      };

      const result = renderOfflineAudio([clip], [], config);

      expect(result.clipping).toBe(false);
    });

    it('returns correct duration', () => {
      const sampleRate = 48000;
      const config: OfflineRenderConfig = {
        sampleRate,
        channels: 1,
        startUs: 0,
        endUs: 2_000_000,
      };

      const result = renderOfflineAudio([], [], config);

      expect(result.durationUs).toBe(2_000_000);
      expect(result.sampleRate).toBe(sampleRate);
      expect(result.channels).toBe(1);
    });

    it('ramps resolved automation across short blocks without static zipper steps', () => {
      const result = renderOfflineAudio(
        [
          {
            clipId: 'automation',
            samples: new Float32Array([1, 1, 1, 1]),
            startUs: 0,
            config: defaultClipConfig,
            effects: [],
          },
        ],
        [],
        {
          sampleRate: 1_000_000,
          channels: 1,
          startUs: 0,
          endUs: 4,
          automation: {
            blockSize: 4,
            clipAt: (_clipId, timeUs, fallback) => ({
              ...fallback,
              gain: 1 - timeUs / 4,
            }),
          },
        },
      );
      expect([...result.samples]).toEqual([1, 0.75, 0.5, 0.25]);
    });
  });
});
