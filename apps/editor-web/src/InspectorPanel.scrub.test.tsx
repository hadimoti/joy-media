// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import type { AudioState } from '@joy-media/commands';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { effectRegistry, registerBuiltins } from '@joy-media/visual-effects';
import {
  InspectorPanel,
  SpeedSection,
  type InspectorClipSpeed,
  type InspectorSpeedChange,
} from './InspectorPanel.js';
import { monitorTransformPreview } from './monitor/monitor-transform-preview.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OBJECT: VisualObjectV1 = {
  id: 'image-1',
  kind: 'image',
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  document.body.innerHTML = '';
});

function mount(
  object: VisualObjectV1,
  onDispatch = vi.fn<(transaction: VisualObjectTransaction) => void>(),
) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <InspectorPanel
        object={object}
        selectedClipId="clip-1"
        allObjects={{ [object.id]: object }}
        playheadUs={0}
        onSetStatic={(objectId, key, value) =>
          onDispatch({
            label: `Set ${key}`,
            commands: [
              {
                type: 'object.setTransformProperty',
                payload: { objectId, key, value },
              },
            ],
          })
        }
        onDispatch={onDispatch}
      />,
    );
  });
  return onDispatch;
}

function mountSpeed(
  onChange: (change: InspectorSpeedChange, label: string) => void,
  speed: InspectorClipSpeed = {
    rate: 1,
    supportsReverse: true,
    supportsRamps: false,
    sourceInUs: 0,
    durationUs: 1_000_000,
  },
): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <SpeedSection
        open
        onToggle={() => undefined}
        clipId="clip-1"
        speed={speed}
        onChange={onChange}
      />,
    );
  });
}

function element<T extends HTMLElement>(selector: string): T {
  const found = container!.querySelector<T>(selector);
  if (found === null) throw new Error(`No element matches ${selector}`);
  return found;
}

function pointer(target: HTMLElement, type: string, clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    isPrimary: { value: true },
  });
  act(() => target.dispatchEvent(event));
}

describe('Inspector numeric scrubbing', () => {
  it('previews crop edits and commits one clamped command when the drag ends', () => {
    const onDispatch = mount(OBJECT);
    const input = element<HTMLInputElement>('#crop-left');
    input.setPointerCapture = vi.fn();

    pointer(input, 'pointerdown', 0);
    pointer(input, 'pointermove', 1000);

    expect(input.value).toBe('0.49');
    expect(onDispatch).not.toHaveBeenCalled();

    pointer(input, 'pointerup', 1000);

    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch.mock.calls[0]?.[0]).toMatchObject({
      label: 'Crop left',
      commands: [
        {
          type: 'object.setCrop',
          payload: { objectId: 'image-1', crop: { left: 0.49 } },
        },
      ],
    });
  });

  it('keeps a scale pair linked and converts opacity scrub percentages to stored values', () => {
    const onDispatch = mount({ ...OBJECT, kind: 'text' });
    act(() => element<HTMLButtonElement>('[aria-label="Link Scale X and Scale Y"]').click());
    const scale = element<HTMLInputElement>('#insp-scaleX');
    scale.setPointerCapture = vi.fn();
    pointer(scale, 'pointerdown', 0);
    pointer(scale, 'pointermove', 4);
    expect(onDispatch).not.toHaveBeenCalled();
    expect([...(monitorTransformPreview.get()?.values() ?? [])][0]?.scaleX).toBe(2);
    pointer(scale, 'pointerup', 4);
    expect(monitorTransformPreview.get()).toBeUndefined();
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch.mock.calls[0]?.[0].commands).toHaveLength(2);
    expect(onDispatch.mock.calls[0]?.[0].commands).toEqual([
      {
        type: 'object.setTransformProperty',
        payload: { objectId: 'image-1', key: 'scaleX', value: 2 },
      },
      {
        type: 'object.setTransformProperty',
        payload: { objectId: 'image-1', key: 'scaleY', value: 2 },
      },
    ]);

    onDispatch.mockClear();
    const opacity = element<HTMLInputElement>('#insp-opacity');
    opacity.setPointerCapture = vi.fn();
    pointer(opacity, 'pointerdown', 0);
    pointer(opacity, 'pointermove', -4);
    expect(opacity.value).toBe('99');
    pointer(opacity, 'pointerup', -4);
    expect(onDispatch.mock.calls[0]?.[0].commands).toEqual([
      {
        type: 'object.setTransformProperty',
        payload: { objectId: 'image-1', key: 'opacity', value: 0.99 },
      },
    ]);

    onDispatch.mockClear();
    const keyframe = element<HTMLButtonElement>('[aria-label="Add Opacity keyframe at playhead"]');
    pointer(keyframe, 'pointerdown', 0);
    pointer(keyframe, 'pointerup', 0);
    act(() => keyframe.click());
    expect(onDispatch.mock.calls[0]?.[0].commands[0]?.type).toBe('object.replaceAnimation');
  });

  it('scrubs all five Adjust parameters and writes an animated effect key at release', () => {
    if (!effectRegistry.hasEffect('brightness-contrast')) registerBuiltins();
    const object: VisualObjectV1 = {
      ...OBJECT,
      kind: 'null',
      effects: [
        {
          id: 'bc',
          effectId: 'brightness-contrast',
          enabled: true,
          params: { brightness: 0, contrast: 0 },
          animations: {
            brightness: {
              keyframes: [
                { timeUs: 0, value: 0, interpolation: 'linear' },
                { timeUs: 1_000_000, value: 0.2, interpolation: 'linear' },
              ],
            },
          },
        },
        { id: 'hs', effectId: 'hue-saturation', enabled: true, params: { hue: 0, saturation: 0 } },
        { id: 'vib', effectId: 'vibrance', enabled: true, params: { amount: 0 } },
      ],
    };
    const onDispatch = vi.fn<(transaction: VisualObjectTransaction) => void>();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <InspectorPanel
          object={object}
          selectedKind="Adjust"
          selectedClipId="adjust-1"
          adjustmentLayer={{ targetClipId: 'clip-1', targets: [] }}
          allObjects={{ [object.id]: object }}
          playheadUs={500_000}
          onSetStatic={() => undefined}
          onDispatch={onDispatch}
        />,
      );
    });

    for (const id of [
      'effect-bc-brightness',
      'effect-bc-contrast',
      'effect-hs-hue',
      'effect-hs-saturation',
      'effect-vib-amount',
    ]) {
      const input = element<HTMLInputElement>(`#${id}`);
      input.setPointerCapture = vi.fn();
      pointer(input, 'pointerdown', 0);
      pointer(input, 'pointermove', 4);
      expect(onDispatch).toHaveBeenCalledTimes(0);
      pointer(input, 'pointerup', 4);
      expect(onDispatch).toHaveBeenCalledTimes(1);
      if (id === 'effect-bc-brightness') {
        expect(onDispatch.mock.calls[0]?.[0].commands[0]?.type).toBe('propertyAnimation.setKey');
      }
      onDispatch.mockClear();
    }
  });

  it('cancels crop scrubs without dispatch and leaves the value at its committed edge', () => {
    const onDispatch = mount(OBJECT);
    const input = element<HTMLInputElement>('#crop-right');
    input.setPointerCapture = vi.fn();
    pointer(input, 'pointerdown', 0);
    pointer(input, 'pointermove', 8);
    expect(input.value).toBe('0.02');
    pointer(input, 'pointercancel', 8);
    expect(input.value).toBe('0');
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('commits volume and pan once after bounded audio scrubs', () => {
    const onAudioChange = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const audioState: AudioState = {
      clips: { 'clip-1': { gain: 1, pan: 0, mute: false, solo: false } },
      buses: [],
      effects: [],
    };
    act(() => {
      root!.render(
        <InspectorPanel
          object={OBJECT}
          selectedClipId="clip-1"
          audioState={audioState}
          onAudioChange={onAudioChange}
          allObjects={{ [OBJECT.id]: OBJECT }}
          playheadUs={0}
          onSetStatic={() => undefined}
          onDispatch={() => undefined}
        />,
      );
    });
    act(() => element<HTMLButtonElement>('[data-panel-tab-id="audio"]').click());
    const volume = element<HTMLInputElement>('#insp-gain');
    volume.setPointerCapture = vi.fn();
    pointer(volume, 'pointerdown', 0);
    pointer(volume, 'pointermove', 1000);
    expect(volume.value).toBe('2');
    expect(onAudioChange).not.toHaveBeenCalled();
    pointer(volume, 'pointerup', 1000);
    expect(onAudioChange).toHaveBeenCalledTimes(1);
    expect(onAudioChange.mock.calls[0]?.[0].clips['clip-1']?.gain).toBe(2);

    const pan = element<HTMLInputElement>('#insp-pan');
    pan.setPointerCapture = vi.fn();
    pointer(pan, 'pointerdown', 0);
    pointer(pan, 'pointermove', -1000);
    expect(pan.value).toBe('-1');
    pointer(pan, 'pointerup', -1000);
    expect(onAudioChange).toHaveBeenCalledTimes(2);
    expect(onAudioChange.mock.calls[1]?.[0].clips['clip-1']?.pan).toBe(-1);
  });

  it('commits a valid speed rate once without crossing direction and defers remap until Apply', () => {
    const onChange = vi.fn();
    mountSpeed(onChange);
    const rate = element<HTMLInputElement>('#insp-speed-rate-clip-1');
    rate.setPointerCapture = vi.fn();
    pointer(rate, 'pointerdown', 0);
    pointer(rate, 'pointermove', -100);
    pointer(rate, 'pointerup', -100);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].rate).toBeGreaterThanOrEqual(0.1);

    onChange.mockClear();
    const remap = element<HTMLInputElement>('#insp-remap-start-clip-1');
    remap.setPointerCapture = vi.fn();
    pointer(remap, 'pointerdown', 0);
    pointer(remap, 'pointermove', 8);
    pointer(remap, 'pointerup', 8);
    expect(remap.value).toBe('2');
    expect(onChange).not.toHaveBeenCalled();
    act(() => element<HTMLButtonElement>('.inspector-speed-actions button').click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].timeRemap).toBeDefined();
  });
});
