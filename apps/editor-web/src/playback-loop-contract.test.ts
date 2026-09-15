import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const boundaryBlock = appSource.slice(
  appSource.indexOf('const advancePlaybackAfterClip ='),
  appSource.indexOf('const capture =', appSource.indexOf('const advancePlaybackAfterClip =')),
);
const toggleBlock = appSource.slice(
  appSource.indexOf('const togglePlayback = useCallback'),
  appSource.indexOf('const dispatchTimeline = useCallback'),
);
const decoderSetupBlock = appSource.slice(
  appSource.indexOf('const handleMediaReady = useCallback'),
  appSource.indexOf('const togglePlayback = useCallback'),
);
const playbackCaptureBlock = appSource.slice(
  appSource.indexOf('if (!state.playing) return;'),
  appSource.indexOf('const handleMediaReady = useCallback'),
);

describe('App loop and Space transport contract', () => {
  it('moves the authoritative playhead before loading the next or wrapped clip', () => {
    const target = boundaryBlock.indexOf('playbackTargetAfterClip(');
    const stateRef = boundaryBlock.indexOf('stateRef.current =', target);
    const sync = boundaryBlock.indexOf('syncMediaToPlayhead(nextPlayheadUs, true, epoch)', target);

    expect(target).toBeGreaterThanOrEqual(0);
    expect(stateRef).toBeGreaterThan(target);
    expect(sync).toBeGreaterThan(stateRef);
    expect(boundaryBlock).toContain('operation.begin(true)');
    expect(boundaryBlock).toContain('operation.isCurrent(epoch)');
    expect(boundaryBlock).toContain('operation.intendsToPlay');
    expect(boundaryBlock).toContain('if (!ready)');
    expect(boundaryBlock).toContain('stopPlaybackForEpoch(epoch)');
  });

  it('uses native media EOF as a guaranteed loop signal', () => {
    expect(appSource).toContain("video.addEventListener('ended', onEnded)");
    expect(appSource).toContain("video.removeEventListener('ended', onEnded)");
    expect(appSource).toContain('advancePlaybackAfterClip(clip.startUs + clip.durationUs)');
  });

  it('makes pending playback pausable and ignores stale completions', () => {
    expect(toggleBlock).toContain('if (operation.intendsToPlay)');
    expect(toggleBlock).toContain('operation.begin(false)');
    expect(toggleBlock).toContain('operation.begin(true)');
    expect(toggleBlock).toContain(
      'stateRef.current = { ...current, playheadUs: startUs, playing: true }',
    );
    expect(toggleBlock).toContain('if (ready || !operation.isCurrent(epoch)) return;');
  });

  it('rehydrates replaced media resolvers at the live playhead', () => {
    expect(decoderSetupBlock).toContain('const current = stateRef.current;');
    expect(decoderSetupBlock).toContain(
      'syncMediaToPlayhead(current.playheadUs, shouldPlay, epoch)',
    );
    expect(decoderSetupBlock).toContain('setPreviewVideoFrame(undefined);');
    expect(decoderSetupBlock).not.toContain(
      'activeVideoClipAt(session.timelineProject, 0, [], session.visualProject)',
    );
    expect(decoderSetupBlock).toContain(
      'setMediaReadyRevision((revision) => revision + 1);',
    );
    expect(playbackCaptureBlock).toContain('mediaReadyRevision,');
    expect(appSource).toContain('decoderRef.current !== decoder');
  });

  it('guards repeated Space and shortcut-owned controls', () => {
    expect(appSource).toContain("action === 'playback.toggle' && event.repeat");
    expect(appSource).toContain('isInteractiveTarget(event.target)');
    expect(appSource).toContain('if (event.defaultPrevented) return;');
  });
});
