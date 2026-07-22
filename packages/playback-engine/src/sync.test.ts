import { describe, expect, it } from 'vitest';
import { createHtmlVideoMediaClock, PlaybackScheduler, type MediaClock } from './index.js';

/** Deterministic clock for sync-drift tests. */
class FakeMediaClock implements MediaClock {
  #timeUs: number;
  constructor(timeUs = 0) {
    this.#timeUs = timeUs;
  }
  get timeUs(): number {
    return this.#timeUs;
  }
  advance(deltaUs: number): void {
    this.#timeUs += deltaUs;
  }
  set(timeUs: number): void {
    this.#timeUs = timeUs;
  }
}

describe('playback-engine sync clock (WP-11.3)', () => {
  it('createHtmlVideoMediaClock reads HTMLVideoElement.currentTime in microseconds', () => {
    const video = { currentTime: 0 } as unknown as HTMLVideoElement;
    const clock = createHtmlVideoMediaClock(video);
    video.currentTime = 1.5;
    expect(clock.timeUs).toBe(1_500_000);
    video.currentTime = 0.000_001;
    expect(clock.timeUs).toBe(1);
  });

  it('createHtmlVideoMediaClock accepts a readTimeUs override for tests', () => {
    const video = { currentTime: 999 } as unknown as HTMLVideoElement;
    const clock = createHtmlVideoMediaClock(video, () => 42_000);
    expect(clock.timeUs).toBe(42_000);
  });

  it('driftFrom returns the signed delta between the clock and the audio time', () => {
    const scheduler = new PlaybackScheduler(48_000);
    const clock = new FakeMediaClock(1_000_000);
    scheduler.seek(1_250_000);
    expect(scheduler.driftFrom(clock)).toBe(-250_000);
    clock.set(1_500_000);
    expect(scheduler.driftFrom(clock)).toBe(250_000);
  });

  it('driveTick reports on-time when drift is within tolerance and decodes succeed', () => {
    const scheduler = new PlaybackScheduler();
    const clock = new FakeMediaClock(33_333); // clock at first frame time (after seek(0), driveTick advances audio to 33333)
    scheduler.seek(0);
    const tick = scheduler.driveTick(clock, true);
    expect(tick.onTime).toBe(true);
    expect(tick.dropped).toBe(false);
    expect(tick.decoded).toBe(true);
    expect(tick.driftUs).toBe(0);
    expect(scheduler.metrics.decodedFrames).toBe(1);
    expect(scheduler.metrics.droppedFrames).toBe(0);
    expect(scheduler.metrics.quality).toBe('full');
  });

  it('driveTick marks a frame as dropped when drift exceeds the tolerance', () => {
    const scheduler = new PlaybackScheduler();
    const clock = new FakeMediaClock(33_333 + 100_000); // clock at first frame + 100ms ahead of scheduler's audio time after first tick
    scheduler.seek(0);
    const tick = scheduler.driveTick(clock, true);
    expect(tick.onTime).toBe(false);
    expect(tick.dropped).toBe(true);
    expect(scheduler.metrics.droppedFrames).toBe(1);
    expect(scheduler.metrics.decodedFrames).toBe(1);
  });

  it('driveTick reports a drop when real decode work fails, without counting it as decoded', () => {
    const scheduler = new PlaybackScheduler();
    const clock = new FakeMediaClock(33_333); // clock at first frame time (after seek(0))
    scheduler.seek(0);
    const tick = scheduler.driveTick(clock, false);
    expect(tick.decoded).toBe(false);
    expect(tick.dropped).toBe(true);
    expect(tick.onTime).toBe(true); // timing was fine, decode failed
    expect(scheduler.metrics.decodedFrames).toBe(0);
    expect(scheduler.metrics.droppedFrames).toBe(1);
  });

  it('recordDecodedFrame distinguishes real decode work from token-only acceptance', () => {
    const scheduler = new PlaybackScheduler();
    const token = scheduler.requestToken();
    expect(scheduler.recordDecodedFrame(token, true, true)).toBe(true);
    expect(scheduler.recordDecodedFrame(token, false, true)).toBe(true);
    expect(scheduler.metrics.decodedFrames).toBe(1);
    expect(scheduler.metrics.droppedFrames).toBe(1);
  });

  it('recordDecodedFrame rejects tokens from a previous generation', () => {
    const scheduler = new PlaybackScheduler();
    const stale = scheduler.requestToken();
    scheduler.seek(1_000_000);
    expect(scheduler.recordDecodedFrame(stale, true, true)).toBe(false);
    expect(scheduler.metrics.decodedFrames).toBe(0);
  });

  it('stays within drift tolerance across 30 s of on-time playback at 30 fps', () => {
    const scheduler = new PlaybackScheduler();
    const clock = new FakeMediaClock(33_333); // clock at first frame time (after seek(0))
    scheduler.seek(0);
    const frameIntervalUs = 33_333; // 1/30 s, the default tolerance
    const totalFrames = 30 * 30; // 30 s @ 30 fps
    let maxDrift = 0;
    for (let i = 1; i <= totalFrames; i++) {
      clock.set(i * frameIntervalUs);
      const tick = scheduler.driveTick(clock, true);
      maxDrift = Math.max(maxDrift, Math.abs(tick.driftUs));
      if (!tick.onTime) break; // bail early on first failure
    }
    expect(maxDrift).toBeLessThanOrEqual(scheduler.driftToleranceUs);
    expect(scheduler.metrics.maxDriftUs).toBe(maxDrift);
    expect(scheduler.metrics.droppedFrames).toBe(0);
    expect(scheduler.metrics.decodedFrames).toBe(totalFrames);
    expect(scheduler.metrics.quality).toBe('full');
  });

  it('tolerates bounded jitter: ±1/2 frame of clock jitter stays within tolerance', () => {
    const scheduler = new PlaybackScheduler();
    const clock = new FakeMediaClock(33_333); // clock at first frame time (after seek(0))
    scheduler.seek(0);
    const totalFrames = 100;
    const frameIntervalUs = 33_333;
    const jitterPattern: number[] = [
      0,
      Math.floor(frameIntervalUs / 4),
      Math.floor(frameIntervalUs / 2),
      Math.floor(frameIntervalUs / 4),
      -Math.floor(frameIntervalUs / 4),
      0,
      -Math.floor(frameIntervalUs / 2),
      -Math.floor(frameIntervalUs / 4),
    ];
    let maxDrift = 0;
    for (let i = 1; i <= totalFrames; i++) {
      const jitter = jitterPattern[i % jitterPattern.length]!;
      clock.set(i * frameIntervalUs + jitter);
      const tick = scheduler.driveTick(clock, true);
      maxDrift = Math.max(maxDrift, Math.abs(tick.driftUs));
      if (!tick.onTime) break;
    }
    expect(scheduler.metrics.droppedFrames).toBe(0);
    expect(maxDrift).toBeLessThanOrEqual(scheduler.driftToleranceUs);
  });

  it('reports dropped frames when the clock stalls longer than the tolerance', () => {
    const scheduler = new PlaybackScheduler();
    const clock = new FakeMediaClock(33_333); // clock at first frame time (after seek(0))
    scheduler.seek(0);
    // 1 frame worth of clock advancement: on time
    clock.set(33_333);
    expect(scheduler.driveTick(clock, true).onTime).toBe(true);
    // 5 frames later: 4 * 33 333 µs past deadline, decode still succeeds but
    // the frame is late and must be reported as dropped.
    clock.set(33_333 * 6);
    const late = scheduler.driveTick(clock, true);
    expect(late.onTime).toBe(false);
    expect(late.dropped).toBe(true);
    expect(scheduler.metrics.droppedFrames).toBe(1);
  });

  it('honours a custom drift tolerance', () => {
    const scheduler = new PlaybackScheduler(48_000, { driftToleranceUs: 1_000 });
    const clock = new FakeMediaClock(33_333); // clock at first frame time
    scheduler.seek(0);
    // First frame: clock and audio both at ~33,333 (drift ≈ 0)
    expect(scheduler.driveTick(clock, true).onTime).toBe(true);
    // Second frame: advance clock by 1 frame + 500µs (within 1ms tolerance)
    clock.set(33_333 + 33_333 + 500); // = 67,166
    expect(scheduler.driveTick(clock, true).onTime).toBe(true);
    // Third frame: advance clock by 1 frame + 1,500µs (exceeds 1ms tolerance)
    clock.set(33_333 * 3 + 1_500); // = 101,500
    expect(scheduler.driveTick(clock, true).onTime).toBe(false);
  });
});
