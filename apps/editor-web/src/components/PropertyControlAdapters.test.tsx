import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ColorPropertyControl,
  createTransientControlAdapter,
  NumericPropertyControl,
  SelectPropertyControl,
  SliderPropertyControl,
  SwitchPropertyControl,
} from './PropertyControlAdapters.js';
import {
  TransientPropertyInteraction,
  type PropertyInteractionCommit,
} from '../property-interaction.js';

function createHarness<T>(initial: T) {
  let value = initial;
  const commit = vi.fn<(change: PropertyInteractionCommit<T>) => void>();
  const interaction = new TransientPropertyInteraction<T>({
    read: () => value,
    preview: (next) => {
      value = next;
    },
    restore: (next) => {
      value = next;
    },
    commit,
  });
  return {
    interaction,
    commit,
    get value() {
      return value;
    },
  };
}

describe('property control adapters', () => {
  it('makes a long slider gesture one durable commit', () => {
    const harness = createHarness(0);
    const adapter = createTransientControlAdapter(harness.interaction, 'Adjust opacity');

    adapter.begin();
    adapter.preview(0.25);
    adapter.preview(0.5);
    adapter.preview(0.75);
    adapter.commit();

    expect(harness.commit).toHaveBeenCalledOnce();
    expect(harness.commit).toHaveBeenCalledWith({
      label: 'Adjust opacity',
      previous: 0,
      next: 0.75,
    });
  });

  it('cancels numeric, discrete, and compound gestures without a history command', () => {
    const numeric = createHarness(10);
    const discrete = createHarness<'linear' | 'hold'>('linear');
    const compound = createHarness({ x: 0, y: 0, linked: true });

    const numericAdapter = createTransientControlAdapter(numeric.interaction, 'Position X');
    const discreteAdapter = createTransientControlAdapter(discrete.interaction, 'Interpolation');
    const compoundAdapter = createTransientControlAdapter(compound.interaction, 'Position');

    numericAdapter.preview(120);
    numericAdapter.cancel();
    discreteAdapter.preview('hold');
    discreteAdapter.cancel();
    compoundAdapter.preview({ x: 120, y: 80, linked: true });
    compoundAdapter.cancel();

    expect(numeric.value).toBe(10);
    expect(discrete.value).toBe('linear');
    expect(compound.value).toEqual({ x: 0, y: 0, linked: true });
    expect(numeric.commit).not.toHaveBeenCalled();
    expect(discrete.commit).not.toHaveBeenCalled();
    expect(compound.commit).not.toHaveBeenCalled();
  });

  it('renders native controls with named accessible semantics', () => {
    const scalar = createTransientControlAdapter(createHarness(1).interaction, 'Adjust gain');
    const color = createTransientControlAdapter(createHarness('#ffcc00').interaction, 'Set tint');
    const mode = createTransientControlAdapter(
      createHarness<'normal' | 'screen'>('normal').interaction,
      'Set blend mode',
    );
    const enabled = createTransientControlAdapter(
      createHarness(true).interaction,
      'Toggle enabled',
    );
    const markup = renderToStaticMarkup(
      <>
        <NumericPropertyControl id="gain" value={1} adapter={scalar} ariaLabel="Gain" />
        <SliderPropertyControl
          value={1}
          min={0}
          max={2}
          step={0.1}
          adapter={scalar}
          ariaLabel="Gain"
        />
        <ColorPropertyControl id="tint" value="#ffcc00" adapter={color} ariaLabel="Tint" />
        <SelectPropertyControl
          id="blend"
          value="normal"
          adapter={mode}
          ariaLabel="Blend mode"
          options={[
            { value: 'normal', label: 'Normal' },
            { value: 'screen', label: 'Screen' },
          ]}
        />
        <SwitchPropertyControl checked adapter={enabled} ariaLabel="Enabled" />
      </>,
    );

    expect(markup).toContain('id="gain"');
    expect(markup).toContain('type="range"');
    expect(markup).toContain('type="color"');
    expect(markup).toContain('aria-label="Blend mode"');
    expect(markup).toContain('role="switch"');
  });
});
