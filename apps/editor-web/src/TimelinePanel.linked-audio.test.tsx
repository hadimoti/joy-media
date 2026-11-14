// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip } from '@joy-media/test-fixtures';
import { EditorPanelContext, type EditorPanelContextValue } from './editor-panel-context.js';
import { TimelinePanel } from './TimelinePanel.js';
import { clearTimelineMediaCaches } from './timeline-media-cache.js';

// A blob whose type says whether the fake decoder finds an audio stream in it.
vi.mock('./timeline-media-cache.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    decodeTimelineWaveform: async (blob: Blob) =>
      blob.type === 'video/x-has-sound'
        ? [
            { min: -0.4, max: 0.4 },
            { min: -0.9, max: 0.9 },
          ]
        : undefined,
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SECOND_US = 1_000_000;
const PX_PER_SECOND = 20;

let root: Root | undefined;
let container: HTMLElement | undefined;

beforeEach(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  clearTimelineMediaCaches();
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

function track(id: string, order: number, family: 'visual' | 'audio', clips: Track['clips']) {
  return { id, kind: 'video', family, order, enabled: true, clips } as Track;
}

function project(a1Clips: Track['clips'] = []) {
  const base = emptySpikeProject({ trackCount: 0, durationUs: 30 * SECOND_US });
  const composition = base.compositions.root!;
  return {
    ...base,
    compositions: {
      root: {
        ...composition,
        tracks: [
          track('v1', 1, 'visual', [
            makeVideoClip('with-sound', 0, 10 * SECOND_US, { assetId: 'asset-sound' }),
            makeVideoClip('no-sound', 12 * SECOND_US, 4 * SECOND_US, { assetId: 'asset-quiet' }),
          ]),
          track('a1', 0, 'audio', a1Clips),
        ],
      },
    },
  };
}

const loadProjectAssetBlob = async (assetId: string) =>
  new Blob([assetId], { type: assetId === 'asset-sound' ? 'video/x-has-sound' : 'video/x-silent' });

async function mountPanel(documentProject: ReturnType<typeof project>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const noop = vi.fn();
  const context = { loadProjectAssetBlob } as unknown as EditorPanelContextValue;
  await act(async () => {
    root?.render(
      <EditorPanelContext.Provider value={context}>
        <TimelinePanel
          project={documentProject}
          playheadUs={0}
          playing={false}
          selectedIds={[]}
          viewport={{ originUs: 0, pixelsPerSecond: PX_PER_SECOND }}
          onViewportChange={noop}
          autoFit={false}
          onAutoFitChange={noop}
          onTogglePlayback={noop}
          onSeek={noop}
          onToggleSelection={noop}
          onClearSelection={noop}
          onDispatch={noop}
        />
      </EditorPanelContext.Provider>,
    );
  });
  // Let the one-at-a-time audio probe finish for both assets.
  for (let round = 0; round < 6; round += 1) await act(async () => Promise.resolve());
  return container;
}

const stripsIn = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>('.timeline-linked-audio-strip'),
];
const laneOf = (host: HTMLElement, trackId: string) =>
  host.querySelector<HTMLElement>(`.timeline-lane[data-track-id="${trackId}"]`)!;

describe('the audio of a video clip shown on the A1 lane', () => {
  it('draws a strip on A1 for a clip whose asset has audio, and none for a silent one', async () => {
    const host = await mountPanel(project());
    const strips = stripsIn(host);
    expect(strips).toHaveLength(1);
    expect(strips[0]!.dataset.linkedAudioClip).toBe('with-sound');
    expect(strips[0]!.dataset.startUs).toBe('0');
    expect(strips[0]!.dataset.endUs).toBe(String(10 * SECOND_US));
    expect(laneOf(host, 'a1').contains(strips[0]!)).toBe(true);
    expect(laneOf(host, 'v1').querySelector('.timeline-linked-audio-strip')).toBeNull();
    // Display only: no text, no handles, no selectable clip.
    expect(strips[0]!.textContent).toBe('');
    expect(strips[0]!.querySelector('.timeline-clip, .timeline-clip-handle, button')).toBeNull();
    expect(strips[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(strips[0]!.querySelector('.timeline-clip-waveform')).not.toBeNull();
  });

  it('lets a real A1 clip win: the strip is cut out under it', async () => {
    const host = await mountPanel(
      project([makeVideoClip('voice-real', 2 * SECOND_US, 3 * SECOND_US, { assetId: 'wav-real' })]),
    );
    const spans = stripsIn(host).map((strip) => [strip.dataset.startUs, strip.dataset.endUs]);
    expect(spans).toEqual([
      ['0', String(2 * SECOND_US)],
      [String(5 * SECOND_US), String(10 * SECOND_US)],
    ]);
  });

  it('draws nothing under a real A1 clip that covers the whole video clip', async () => {
    const host = await mountPanel(
      project([makeVideoClip('voice-real', 0, 11 * SECOND_US, { assetId: 'wav-real' })]),
    );
    expect(stripsIn(host)).toHaveLength(0);
  });

  it('draws nothing when the file cannot be loaded', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const noop = vi.fn();
    const context = {
      loadProjectAssetBlob: async () => undefined,
    } as unknown as EditorPanelContextValue;
    await act(async () => {
      root?.render(
        <EditorPanelContext.Provider value={context}>
          <TimelinePanel
            project={project()}
            playheadUs={0}
            playing={false}
            selectedIds={[]}
            viewport={{ originUs: 0, pixelsPerSecond: PX_PER_SECOND }}
            onViewportChange={noop}
            autoFit={false}
            onAutoFitChange={noop}
            onTogglePlayback={noop}
            onSeek={noop}
            onToggleSelection={noop}
            onClearSelection={noop}
            onDispatch={noop}
          />
        </EditorPanelContext.Provider>,
      );
    });
    for (let round = 0; round < 6; round += 1) await act(async () => Promise.resolve());
    expect(stripsIn(container)).toHaveLength(0);
  });

  it('does not change the project document', async () => {
    const documentProject = project([
      makeVideoClip('voice-real', 2 * SECOND_US, 3 * SECOND_US, { assetId: 'wav-real' }),
    ]);
    const before = structuredClone(documentProject);
    const host = await mountPanel(documentProject);
    expect(stripsIn(host).length).toBeGreaterThan(0);
    expect(documentProject).toEqual(before);
  });
});
