// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationCostCard } from './GenerationCostCard.js';
import { GENERATION_COST_ESTIMATES, generationCostLine } from './generation-cost-estimates.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('generation cost estimates (T-C07)', () => {
  it('reads every price from the one constant and marks it as not measured until T-C10', () => {
    expect(GENERATION_COST_ESTIMATES.measured).toBe(false);
    expect(generationCostLine('image')).toBe(
      `About $${GENERATION_COST_ESTIMATES.usd.image.toFixed(2)} (not measured yet)`,
    );
    expect(generationCostLine('video')).toBe(
      `About $${GENERATION_COST_ESTIMATES.usd.video.toFixed(2)} (not measured yet)`,
    );
  });
});

describe('GenerationCostCard', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    if (root !== undefined) act(() => root?.unmount());
    root = undefined;
    container.remove();
  });

  function mount(props: Partial<Parameters<typeof GenerationCostCard>[0]> = {}) {
    const onAllow = vi.fn();
    const onDecline = vi.fn();
    root = createRoot(container);
    act(() =>
      root?.render(
        <GenerationCostCard
          kind="video"
          providerName="MiniMax"
          onAllow={onAllow}
          onDecline={onDecline}
          {...props}
        />,
      ),
    );
    return { onAllow, onDecline };
  }

  it('names the provider, the kind and the price, with Allow and Decline', () => {
    mount();
    const text = container.textContent ?? '';
    expect(text).toContain('MiniMax · Video');
    expect(text).toContain(generationCostLine('video'));
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Allow', 'Decline']);
  });

  it('shows the picture price for a picture', () => {
    mount({ kind: 'image' });
    expect(container.textContent).toContain('MiniMax · Picture');
    expect(container.textContent).toContain(generationCostLine('image'));
  });

  it('calls only the handler of the button that was pressed', () => {
    const { onAllow, onDecline } = mount();
    const [allow, decline] = [...container.querySelectorAll('button')];
    act(() => decline?.click());
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAllow).not.toHaveBeenCalled();
    act(() => allow?.click());
    expect(onAllow).toHaveBeenCalledTimes(1);
  });
});
