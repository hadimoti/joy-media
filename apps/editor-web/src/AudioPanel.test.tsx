import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AudioPanel, prepareAudioCommandState } from './AudioPanel.js';
import { EMPTY_AUDIO_STATE } from './audio-session.js';
import { applyAudioCommand } from '@joy-media/commands';

describe('AudioPanel Enhance workspace', () => {
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
    expect(markup).toContain('Review changes');
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
});
