// @vitest-environment jsdom
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JoyCodeMessagePart } from './joy-code-history.js';
import {
  formatJoyCodeElapsed,
  JoyCodeMediaParts,
  type JoyCodeMediaReader,
} from './joy-code-media-parts.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PNG = { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' };
const MP4 = { bytes: new Uint8Array([0, 0, 0, 24]), mimeType: 'video/mp4' };

type JobPart = Extract<JoyCodeMessagePart, { kind: 'job' }>;

function job(overrides: Partial<JobPart> = {}): JobPart {
  return {
    kind: 'job',
    jobId: 'job-1',
    mediaKind: 'image',
    state: 'running',
    startedAt: '2026-11-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('Joy Code picture, video and job parts', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    let counter = 0;
    createObjectURL = vi.fn(() => `blob:test-${++counter}`);
    revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(node: ReactNode): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
    return container!;
  }

  function buttonNamed(rendered: ParentNode, name: string): HTMLButtonElement {
    const found = [...rendered.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === name || button.getAttribute('aria-label') === name,
    );
    if (found === undefined) throw new Error(`no button named ${name}`);
    return found;
  }

  describe('text part', () => {
    it('shows the text', async () => {
      const rendered = await render(
        <JoyCodeMediaParts parts={[{ kind: 'text', text: 'Here is your picture' }]} />,
      );
      expect(rendered.querySelector('.joy-code-part-text')!.textContent).toBe(
        'Here is your picture',
      );
    });
  });

  describe('picture part', () => {
    it('reads the bytes by job id, never by path, and shows a thumbnail', async () => {
      const readMedia = vi.fn<JoyCodeMediaReader>(async () => PNG);
      const rendered = await render(
        <JoyCodeMediaParts parts={[{ kind: 'image', jobId: 'job-9' }]} readMedia={readMedia} />,
      );
      expect(readMedia).toHaveBeenCalledTimes(1);
      expect(readMedia).toHaveBeenCalledWith('job-9');
      const img = rendered.querySelector('.joy-code-media-thumb img') as HTMLImageElement;
      expect(img.getAttribute('src')).toBe('blob:test-1');
      expect(img.getAttribute('alt')).toBe('Generated picture');
    });

    it('opens a lightbox from the thumbnail and closes it with Escape, returning focus', async () => {
      const rendered = await render(
        <JoyCodeMediaParts
          parts={[{ kind: 'image', jobId: 'job-1', label: 'Sunset' }]}
          readMedia={async () => PNG}
        />,
      );
      const thumb = buttonNamed(rendered, 'Open Sunset');
      expect(rendered.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => {
        thumb.click();
      });
      const dialog = rendered.querySelector('[role="dialog"]') as HTMLElement;
      expect(dialog).not.toBeNull();
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.querySelector('img')!.getAttribute('alt')).toBe('Sunset');
      expect(document.activeElement).toBe(buttonNamed(dialog, 'Close'));

      await act(async () => {
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(rendered.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(thumb);
    });

    it('closes the lightbox with its Close button and keeps Tab inside it', async () => {
      const rendered = await render(
        <JoyCodeMediaParts
          parts={[{ kind: 'image', jobId: 'job-1' }]}
          readMedia={async () => PNG}
        />,
      );
      await act(async () => {
        buttonNamed(rendered, 'Open Generated picture').click();
      });
      const dialog = rendered.querySelector('[role="dialog"]') as HTMLElement;
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      await act(async () => {
        dialog.dispatchEvent(tab);
      });
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(buttonNamed(dialog, 'Close'));
      await act(async () => {
        buttonNamed(dialog, 'Close').click();
      });
      expect(rendered.querySelector('[role="dialog"]')).toBeNull();
    });

    it('shows a loading word until the bytes arrive', async () => {
      let release: (value: typeof PNG) => void = () => undefined;
      const pendingRead = new Promise<typeof PNG>((resolve) => {
        release = resolve;
      });
      const rendered = await render(
        <JoyCodeMediaParts
          parts={[{ kind: 'image', jobId: 'job-1' }]}
          readMedia={() => pendingRead}
        />,
      );
      expect(rendered.querySelector('.joy-code-media-loading')!.textContent).toBe('Loading');
      expect(rendered.querySelector('img')).toBeNull();
      await act(async () => {
        release(PNG);
      });
      expect(rendered.querySelector('.joy-code-media-loading')).toBeNull();
      expect(rendered.querySelector('img')).not.toBeNull();
    });

    it('says so in plain words when there are no bytes, and Try again reads again', async () => {
      const readMedia = vi
        .fn<JoyCodeMediaReader>()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(PNG);
      const rendered = await render(
        <JoyCodeMediaParts parts={[{ kind: 'image', jobId: 'job-1' }]} readMedia={readMedia} />,
      );
      expect(rendered.querySelector('.joy-code-media-problem')!.textContent).toContain(
        'Could not open the picture',
      );
      expect(rendered.querySelector('img')).toBeNull();
      await act(async () => {
        buttonNamed(rendered, 'Try again').click();
      });
      expect(readMedia).toHaveBeenCalledTimes(2);
      expect(rendered.querySelector('.joy-code-media-problem')).toBeNull();
      expect(rendered.querySelector('img')).not.toBeNull();
    });

    it('treats a rejected read and a missing reader as the same plain failure', async () => {
      const rejected = await render(
        <JoyCodeMediaParts
          parts={[{ kind: 'image', jobId: 'job-1' }]}
          readMedia={async () => {
            throw new Error('C:\\secret\\path.png');
          }}
        />,
      );
      expect(rejected.querySelector('.joy-code-media-problem')!.textContent).toBe(
        'Could not open the pictureTry again',
      );
      expect(rejected.textContent).not.toContain('secret');
      act(() => root?.unmount());
      container?.remove();

      const missing = await render(
        <JoyCodeMediaParts parts={[{ kind: 'image', jobId: 'job-1' }]} />,
      );
      expect(missing.querySelector('.joy-code-media-problem')).not.toBeNull();
    });

    it('releases the blob link when it unmounts', async () => {
      await render(
        <JoyCodeMediaParts
          parts={[{ kind: 'image', jobId: 'job-1' }]}
          readMedia={async () => PNG}
        />,
      );
      expect(revokeObjectURL).not.toHaveBeenCalled();
      act(() => root?.unmount());
      root = undefined;
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
    });

    it('calls each action with the job id and nothing else', async () => {
      const handlers = {
        onAddToLibrary: vi.fn(),
        onPlaceOnTimeline: vi.fn(),
        onSaveAs: vi.fn(),
        onDiscard: vi.fn(),
        onCancel: vi.fn(),
      };
      const rendered = await render(
        <JoyCodeMediaParts
          parts={[{ kind: 'image', jobId: 'job-7' }]}
          readMedia={async () => PNG}
          {...handlers}
        />,
      );
      for (const [name, handler] of [
        ['Add to library', handlers.onAddToLibrary],
        ['Place on timeline', handlers.onPlaceOnTimeline],
        ['Save as', handlers.onSaveAs],
        ['Discard', handlers.onDiscard],
      ] as const) {
        await act(async () => {
          buttonNamed(rendered, name).click();
        });
        expect(handler, name).toHaveBeenCalledTimes(1);
        expect(handler, name).toHaveBeenCalledWith('job-7');
      }
      expect(handlers.onCancel).not.toHaveBeenCalled();
    });

    it('buttons are safe to press without handlers', async () => {
      const rendered = await render(
        <JoyCodeMediaParts
          parts={[{ kind: 'image', jobId: 'job-1' }]}
          readMedia={async () => PNG}
        />,
      );
      for (const name of ['Add to library', 'Place on timeline', 'Save as', 'Discard']) {
        await act(async () => {
          buttonNamed(rendered, name).click();
        });
      }
      expect(rendered.querySelector('.joy-code-media-actions')).not.toBeNull();
    });
  });

  describe('video part', () => {
    it('shows a video with play controls and the four buttons', async () => {
      const rendered = await render(
        <JoyCodeMediaParts
          parts={[{ kind: 'video', jobId: 'job-2' }]}
          readMedia={async () => MP4}
        />,
      );
      const video = rendered.querySelector('video') as HTMLVideoElement;
      expect(video.controls).toBe(true);
      expect(video.getAttribute('src')).toBe('blob:test-1');
      expect(video.getAttribute('aria-label')).toBe('Generated video');
      expect(
        [...rendered.querySelectorAll('.joy-code-media-actions button')].map((button) =>
          button.textContent?.trim(),
        ),
      ).toEqual(['Add to library', 'Place on timeline', 'Save as', 'Discard']);
    });

    it('releases the blob link when the video unmounts', async () => {
      await render(
        <JoyCodeMediaParts
          parts={[{ kind: 'video', jobId: 'job-2' }]}
          readMedia={async () => MP4}
        />,
      );
      act(() => root?.unmount());
      root = undefined;
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
    });

    it('says so in plain words when the video cannot be read', async () => {
      const rendered = await render(
        <JoyCodeMediaParts
          parts={[{ kind: 'video', jobId: 'job-2' }]}
          readMedia={async () => ({ bytes: new Uint8Array(), mimeType: 'video/mp4' })}
        />,
      );
      expect(rendered.querySelector('video')).toBeNull();
      expect(rendered.querySelector('.joy-code-media-problem')!.textContent).toContain(
        'Could not open the video',
      );
    });
  });

  describe('job card', () => {
    it('shows state and elapsed time, ticking every second while the job works', async () => {
      vi.useFakeTimers();
      let nowMs = Date.parse('2026-11-15T10:00:07.000Z');
      const rendered = await render(
        <JoyCodeMediaParts parts={[job({ state: 'running' })]} now={() => nowMs} />,
      );
      expect(rendered.querySelector('.joy-code-job-state')!.textContent).toBe('Working');
      expect(rendered.querySelector('.joy-code-job-elapsed')!.textContent).toBe('0:07');
      nowMs = Date.parse('2026-11-15T10:01:05.000Z');
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(rendered.querySelector('.joy-code-job-elapsed')!.textContent).toBe('1:05');
    });

    it.each([
      ['queued', 'Waiting'],
      ['running', 'Working'],
      ['downloading', 'Saving'],
      ['completed', 'Done'],
      ['failed', 'Could not make it'],
      ['cancelled', 'Cancelled'],
      ['abandoned-locally', 'Stopped on this computer'],
      ['timed-out', 'Took too long'],
    ] as const)('says %s in plain words', async (state, words) => {
      const rendered = await render(
        <JoyCodeMediaParts
          parts={[job({ state, endedAt: '2026-11-15T10:00:30.000Z' })]}
          now={() => 0}
        />,
      );
      expect(rendered.querySelector('.joy-code-job-state')!.textContent).toBe(words);
      expect(rendered.querySelector('.joy-code-job-card')!.classList.contains(`is-${state}`)).toBe(
        true,
      );
    });

    it('freezes the elapsed time of a finished job at its end time', async () => {
      const rendered = await render(
        <JoyCodeMediaParts
          parts={[job({ state: 'completed', endedAt: '2026-11-15T10:02:03.000Z' })]}
          now={() => Date.parse('2030-01-01T00:00:00.000Z')}
        />,
      );
      expect(rendered.querySelector('.joy-code-job-elapsed')!.textContent).toBe('2:03');
    });

    it.each(['queued', 'running', 'downloading'] as const)(
      'shows Cancel while %s and it calls the handler with the job id',
      async (state) => {
        const onCancel = vi.fn();
        const rendered = await render(
          <JoyCodeMediaParts
            parts={[job({ state, jobId: 'job-5' })]}
            now={() => 0}
            onCancel={onCancel}
          />,
        );
        await act(async () => {
          buttonNamed(rendered, 'Cancel').click();
        });
        expect(onCancel).toHaveBeenCalledWith('job-5');
      },
    );

    it.each(['completed', 'failed', 'cancelled', 'abandoned-locally', 'timed-out'] as const)(
      'shows no Cancel once the job is %s',
      async (state) => {
        const rendered = await render(
          <JoyCodeMediaParts parts={[job({ state })]} now={() => 0} onCancel={vi.fn()} />,
        );
        expect(rendered.querySelectorAll('button')).toHaveLength(0);
      },
    );

    it('Cancel is safe without a handler', async () => {
      const rendered = await render(<JoyCodeMediaParts parts={[job()]} now={() => 0} />);
      await act(async () => {
        buttonNamed(rendered, 'Cancel').click();
      });
      expect(rendered.querySelector('.joy-code-job-card')).not.toBeNull();
    });

    it('marks failures and shows the plain reason it was given', async () => {
      const rendered = await render(
        <JoyCodeMediaParts
          parts={[job({ state: 'failed', reason: 'The picture was not allowed.' })]}
          now={() => 0}
        />,
      );
      expect(rendered.querySelector('.joy-code-job-card')!.classList.contains('is-problem')).toBe(
        true,
      );
      expect(rendered.querySelector('.joy-code-job-reason')!.textContent).toBe(
        'The picture was not allowed.',
      );
    });

    it('names a video job as Video', async () => {
      const rendered = await render(
        <JoyCodeMediaParts parts={[job({ mediaKind: 'video' })]} now={() => 0} />,
      );
      expect(rendered.querySelector('.joy-code-job-kind')!.textContent).toBe('Video');
    });

    it('stops its timer when it unmounts', async () => {
      vi.useFakeTimers();
      await render(<JoyCodeMediaParts parts={[job()]} now={() => 0} />);
      expect(vi.getTimerCount()).toBe(1);
      act(() => root?.unmount());
      root = undefined;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('keeps part order and every button reachable by keyboard', async () => {
    const rendered = await render(
      <JoyCodeMediaParts
        parts={[
          { kind: 'text', text: 'Done' },
          { kind: 'image', jobId: 'a' },
          { kind: 'video', jobId: 'b' },
          job({ jobId: 'c' }),
        ]}
        readMedia={async (jobId) => (jobId === 'b' ? MP4 : PNG)}
        now={() => 0}
      />,
    );
    const kinds = [...rendered.querySelector('.joy-code-parts')!.children].map(
      (child) => child.className.split(' ')[0],
    );
    expect(kinds).toEqual([
      'joy-code-part-text',
      'joy-code-media-card',
      'joy-code-media-card',
      'joy-code-job-card',
    ]);
    for (const button of rendered.querySelectorAll('button')) {
      expect(button.tabIndex, button.textContent ?? '').toBeGreaterThanOrEqual(0);
      expect(button.getAttribute('type')).toBe('button');
    }
    // Picture thumbnail + 4 buttons, 4 buttons for the video, and Cancel.
    expect(rendered.querySelectorAll('button')).toHaveLength(1 + 4 + 4 + 1);
  });

  it('formats elapsed time as minutes and seconds', () => {
    expect(formatJoyCodeElapsed(0)).toBe('0:00');
    expect(formatJoyCodeElapsed(999)).toBe('0:00');
    expect(formatJoyCodeElapsed(65_000)).toBe('1:05');
    expect(formatJoyCodeElapsed(-5)).toBe('0:00');
  });
});
