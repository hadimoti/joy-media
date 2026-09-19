import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AudioPanel, prepareAudioCommandState, selectConnectedAudioWorker } from './AudioPanel.js';
import type { BrowserWorker } from './control-plane-client.js';
import { EMPTY_AUDIO_STATE } from './audio-session.js';
import { applyAudioCommand } from '@joy-media/commands';

describe('AudioPanel Enhance workspace', () => {
  it('selects a capable recent Worker instead of depending on API list order', () => {
    const renderWorker: BrowserWorker = {
      id: 'render-worker',
      paired: true,
      revoked: false,
      capabilities: ['render.export'],
      lastSeenAt: 1_000,
    };
    const audioWorker: BrowserWorker = {
      id: 'audio-worker',
      paired: true,
      revoked: false,
      capabilities: ['audio.ml-denoise'],
      lastSeenAt: 1_000,
    };

    expect(selectConnectedAudioWorker([renderWorker, audioWorker], 1_001)?.id).toBe('audio-worker');
    expect(selectConnectedAudioWorker([renderWorker], 1_001)).toBeUndefined();
    expect(selectConnectedAudioWorker([audioWorker], 36_001)).toBeUndefined();
  });

  it('hydrates a newly visible clip before applying a mix command', () => {
    const hydrated = prepareAudioCommandState(EMPTY_AUDIO_STATE, ['voice-1']);
    const { state } = applyAudioCommand(hydrated, {
      type: 'audioClip.setGain',
      payload: { clipId: 'voice-1', gain: 1.25 },
    });

    expect(state.clips['voice-1']).toMatchObject({ gain: 1.25 });
  });

  it('server-renders a scoped, review-before-apply Enhance workspace', () => {
    const markup = renderToStaticMarkup(
      <AudioPanel
        clipIds={['voice-a', 'voice-b']}
        audioState={EMPTY_AUDIO_STATE}
        onAudioChange={() => undefined}
        onRunBrowserDsp={() => undefined}
      />,
    );

    expect(markup.indexOf('Enhance target')).toBeLessThan(markup.indexOf('Choose an enhancement'));
    expect(markup).toContain('Voice Polish');
    expect(markup).toContain('Processing plan');
    expect(markup).toContain('3/3 ready');
    expect(markup).toContain('aria-label="Review Voice Polish changes"');
    expect(markup).toContain('title="Review Voice Polish changes"');
    expect(markup).toContain('audio-enhance-heading-icon');
    expect(markup).toContain('audio-enhance-runtime-button');
    expect(markup).toMatch(/audio-enhance-runtime-button[^>]*><svg/);
    expect(markup).toContain('icon-button-labeled audio-enhance-primary');
    expect(markup).toContain('audio-workflow-card-icon');
    expect(markup).toContain('audio-workflow-step-icon');
    expect(markup).toContain('Browser DSP ready');
    expect(markup).toContain('<strong>Browser</strong>DSP');
    expect(markup).not.toContain('<strong>0G</strong>RAM');
    expect(markup).toContain('Local Worker disconnected');
    expect(markup).toContain('Timeline');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('audio-workflow-icon');
    expect(markup).not.toContain('Capability Library');
  });

  it('keeps the current Enhance, Mix, and Runtime tabs without legacy markers', () => {
    const markup = renderToStaticMarkup(
      <AudioPanel
        clipIds={['voice-a']}
        audioState={EMPTY_AUDIO_STATE}
        onAudioChange={() => undefined}
        onRunBrowserDsp={() => undefined}
      />,
    );

    expect(markup).not.toContain('data-audio-route');
    expect(markup).not.toContain('>Studio</button>');
    expect(markup).not.toContain('>Models</button>');
    expect(markup).toContain('>Enhance</button>');
    expect(markup).toContain('>Mix</button>');
    expect(markup).toContain('>Runtime</button>');
  });

  it('renders real-time DSP pills for DeepFilterNet and Normalization in Enhance and Mix views', () => {
    const markup = renderToStaticMarkup(
      <AudioPanel
        clipIds={['voice-a']}
        audioState={EMPTY_AUDIO_STATE}
        onAudioChange={() => undefined}
        onRunBrowserDsp={() => undefined}
      />,
    );

    expect(markup).toContain('timeline-audio-dsp-pills');
    expect(markup).toContain('audio-dsp-pill dsp-dfn');
    expect(markup).toContain('audio-dsp-pill dsp-norm');
    expect(markup).toContain('DFN');
    expect(markup).toContain('NORM');
  });
});
