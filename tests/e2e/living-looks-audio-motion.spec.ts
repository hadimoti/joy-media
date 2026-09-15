import { expect, test } from '@playwright/test';

/**
 * R2 / GAP 2 — audio-reactive Living Looks, real-browser decode + render path.
 *
 * A vitest fake AudioContext proves the maths; this proves the chain works in a
 * real browser: `AudioContext.decodeAudioData` on synthesized beat audio →
 * `bakeLookFromAudio` → `compileLook` (baked keys supersede the slider drive) →
 * the renderer's own curve evaluator (`sampleCurve`). It asserts the subject
 * scale peaks near each beat and settles between.
 *
 * The final decoded-*exported-media* pixel + A/V-sync check (export a
 * Music-Pulse-with-audio-bake project to MP4, decode it, confirm the scale peak
 * near a beat AND a synchronized audio track) stays an owner/CI acceptance step
 * — it needs the full browser export pipeline and a real workspace audio asset,
 * the same way the per-pack taste reviews are owner-gated.
 */

/** A 2 s mono 48 kHz PCM WAV with a decaying low tone on each beat second. */
function synthesizeBeatWav(beatsSeconds: readonly number[]): Buffer {
  const sampleRate = 48_000;
  const durationS = 2;
  const total = sampleRate * durationS;
  const pcm = new Int16Array(total);
  const decay = Math.round(0.12 * sampleRate);
  for (const beat of beatsSeconds) {
    const start = Math.round(beat * sampleRate);
    for (let i = 0; i < decay; i += 1) {
      const index = start + i;
      if (index >= total) break;
      const env = Math.exp((-4 * i) / decay);
      const value = Math.sin((2 * Math.PI * 90 * i) / sampleRate) * env * 0.9;
      pcm[index] = Math.max(-1, Math.min(1, (pcm[index] ?? 0) / 32767 + value)) * 32767;
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer)]);
}

const BEATS = [0.3, 0.6, 0.9, 1.2, 1.5, 1.8];

test('decodes beat audio in a real browser and the renderer evaluator reproduces the motion (GAP 2)', async ({
  page,
}) => {
  const wavBase64 = synthesizeBeatWav(BEATS).toString('base64');
  await page.route('**/__joy-living-looks-audio-harness', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Living Looks audio harness</title>',
    });
  });
  await page.goto('/__joy-living-looks-audio-harness');

  const result = await page.evaluate(
    async ({ wavBase64, beats }) => {
      const { bakeLookFromAudio, compileLook, musicPulse, sampleCurve } =
        await import('/src/living-look-audio-e2e-bridge.ts');

      const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0));
      const audioContext = new AudioContext();
      const decoded = await audioContext.decodeAudioData(bytes.buffer);
      const channels = Array.from(
        { length: decoded.numberOfChannels },
        (_, ch) => new Float32Array(decoded.getChannelData(ch)),
      );
      await audioContext.close();

      const controlValues = Object.fromEntries(
        musicPulse.controls.map((control) => [control.id, control.default]),
      );
      const durationUs = 2_000_000;
      const baked = bakeLookFromAudio({
        definition: musicPulse,
        controlValues,
        audio: { sampleRate: decoded.sampleRate, channels, sourceOffsetUs: 0 },
        clip: {
          compositionStartUs: 0,
          compositionDurationUs: durationUs,
          sourceAnchorUs: 0,
          sourcePerComposition: { numerator: 1, denominator: 1 },
        },
      });

      const compiled = compileLook({
        definition: musicPulse,
        definitionVersion: musicPulse.version,
        compositionId: 'root',
        compositionDurationUs: durationUs,
        format: 'portrait',
        entityBindings: { subject: 'headline', accent: 'badge', captions: 'caption-clip-1' },
        controlValues,
        overriddenBindingIds: [],
        resolvedFonts: Object.fromEntries(musicPulse.requiredFonts.map((f) => [f, f])),
        audioBakes: baked.audioBakes,
      });

      const keyframes = compiled.operations
        .filter(
          (op) =>
            op.kind === 'motion.setKeyframe' &&
            op.ownerId === 'headline' &&
            op.propertyId === 'scaleX',
        )
        .map((op) => ({
          timeUs: (op as { timeUs: number }).timeUs,
          value: (op as { value: number }).value,
          interpolation: (op as { interpolation: 'hold' | 'linear' | 'eased' }).interpolation,
        }))
        .sort((a, b) => a.timeUs - b.timeUs);
      const curve = { keyframes };

      const restingSamples = beats
        .slice(0, -1)
        .map((beat: number, i: number) =>
          sampleCurve(curve, Math.round(((beat + beats[i + 1]) / 2) * 1_000_000)),
        );
      const restingMax = Math.max(...restingSamples);
      let beatsThatPop = 0;
      for (const beat of beats) {
        const beatUs = beat * 1_000_000;
        const nearby = [beatUs - 30_000, beatUs, beatUs + 30_000, beatUs + 60_000]
          .filter((t: number) => t >= 0 && t <= durationUs)
          .map((t: number) => sampleCurve(curve, Math.round(t)));
        if (Math.max(...nearby) > restingMax + 0.001) beatsThatPop += 1;
      }

      const values = keyframes.map((k) => k.value);
      return {
        silent: baked.silent,
        confidence: baked.confidence,
        bakedBindings: baked.audioBakes.map((b) => b.bindingId),
        keyframeCount: keyframes.length,
        minValue: Math.min(...values),
        maxValue: Math.max(...values),
        beatsThatPop,
        totalBeats: beats.length,
      };
    },
    { wavBase64, beats: BEATS },
  );

  expect(result.silent).toBe(false);
  expect(result.confidence).toBeGreaterThan(0.5);
  expect(result.bakedBindings).toContain('subject-scale-x');
  expect(result.keyframeCount).toBeGreaterThan(1);
  // Never outside the pack's declared rest/peak.
  expect(result.minValue).toBeGreaterThanOrEqual(1 - 1e-6);
  expect(result.maxValue).toBeLessThanOrEqual(1.12 + 1e-6);
  // The renderer's evaluator sees the motion peak near the majority of beats.
  expect(result.beatsThatPop).toBeGreaterThanOrEqual(Math.ceil(result.totalBeats / 2));
});
