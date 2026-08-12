import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AudioPanel, prepareAudioCommandState } from './AudioPanel.js';
import { EMPTY_AUDIO_STATE } from './audio-session.js';
import { applyAudioCommand } from '@joy-media/commands';

describe('AudioPanel Studio surface', () => {
  it('hydrates a newly visible clip before applying a mix command', () => {
    const hydrated = prepareAudioCommandState(EMPTY_AUDIO_STATE, ['voice-1']);
    const { state } = applyAudioCommand(hydrated, {
      type: 'audioClip.setGain',
      payload: { clipId: 'voice-1', gain: 1.25 },
    });

    expect(state.clips['voice-1']).toMatchObject({ gain: 1.25 });
  });

  it('server-renders the action-first, honest default Studio state', () => {
    const markup = renderToStaticMarkup(
      <AudioPanel clipIds={[]} audioState={EMPTY_AUDIO_STATE} onAudioChange={() => undefined} />,
    );

    expect(markup.indexOf('Local Worker')).toBeLessThan(markup.indexOf('Choose a workflow'));
    expect(markup.indexOf('Choose a workflow')).toBeLessThan(markup.indexOf('Podcast Quality'));
    expect(markup.indexOf('Podcast Quality')).toBeLessThan(markup.indexOf('Browser DSP'));
    expect(markup).toContain('Local Worker</strong><span>Disconnected</span>');
    expect(markup).toContain('Cloud Brain</strong><span>Unavailable</span>');
    expect(markup).toContain('Place clips to run');
    expect(markup).toContain('title="Place clips to run"');
    expect(markup).toContain('aria-describedby="audio-podcast-quality-run-readiness"');
    expect(markup).toContain('data-audio-route="browser-dsp"');
    expect(markup).toContain('data-audio-route="local-worker"');
    expect(markup).toContain('data-audio-route="vps-orchestrated"');
    expect(markup).toContain('aria-label="Execution target"');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('audio-readiness');
    expect(markup).not.toContain('mic_24x24.png');
    expect(markup).not.toContain('setting-gear_24x24.png');
    expect(markup).toContain('audio-workflow-icon');
    expect(markup).toContain('audio-workflow-step-connector');
    expect(markup).not.toContain('M4 2.5 13 8 4 13.5Z');
    expect(markup).toMatch(/class="icon-tool audio-device-icon"[^>]*><svg/);
  });

  it('keeps the capability library collapsed, filterable, and discoverable', () => {
    const markup = renderToStaticMarkup(
      <AudioPanel clipIds={[]} audioState={EMPTY_AUDIO_STATE} onAudioChange={() => undefined} />,
    );

    expect(markup).toContain('class="audio-capability-library"');
    expect(markup).not.toContain('class="audio-capability-library" open');
    expect(markup).toContain('Capability Library');
    expect(markup).toContain('16 capabilities');
    expect(markup).toContain('Browse the building blocks behind each workflow');
    expect(markup).toContain('aria-label="All: 16 capabilities"');
    expect(markup).toContain('aria-label="Local Worker: 9 capabilities"');
    expect(markup).toContain('aria-label="Browser DSP: 6 capabilities"');
    expect(markup).toContain('aria-label="Cloud Brain: 1 capability"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('audio.denoise');
    expect(markup).toContain('audio.time_stretch');
  });

  it('retains all four PanelShell subtabs', () => {
    const markup = renderToStaticMarkup(
      <AudioPanel clipIds={[]} audioState={EMPTY_AUDIO_STATE} onAudioChange={() => undefined} />,
    );

    expect(markup).toContain('>Studio</button>');
    expect(markup).toContain('>Models</button>');
    expect(markup).toContain('>Master</button>');
    expect(markup).toContain('>Clips</button>');
  });
});
