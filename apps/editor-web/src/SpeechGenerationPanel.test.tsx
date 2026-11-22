// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SpeechGenerationPanel,
  type SpeechGenerationPanelProps,
  type SpeechGenerationResult,
} from './SpeechGenerationPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const readyModels = [
  { modelId: 'faster-whisper-large-v3-turbo', state: 'ready' },
  { modelId: 'kokoro-82m', state: 'ready' },
  { modelId: 'chatterbox-en', state: 'ready' },
  { modelId: 'chatterbox-fa', state: 'ready' },
] as const;

const assets = [
  { id: 'asset-voice-one', label: 'Narration reference' },
  { id: 'asset-music', label: 'Music bed' },
] as const;

function makeProps(
  overrides: Partial<SpeechGenerationPanelProps> = {},
): SpeechGenerationPanelProps {
  return {
    modelStatus: readyModels,
    referenceAssets: assets,
    onGenerate: async () => ({ availability: 'ready' }),
    onAddCaptions: () => undefined,
    onOpenLocalAssets: () => undefined,
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(props: SpeechGenerationPanelProps) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<SpeechGenerationPanel {...props} />));
  return container;
}

async function clickButton(name: string) {
  const button = [...(container?.querySelectorAll('button') ?? [])].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name,
  );
  if (button === undefined) throw new Error(`button not found: ${name}`);
  await act(async () => button.click());
}

async function setCheckbox(labelText: string, checked = true) {
  const label = [...(container?.querySelectorAll('label') ?? [])].find((candidate) =>
    candidate.textContent?.includes(labelText),
  );
  const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (input === null || input === undefined) throw new Error(`checkbox not found: ${labelText}`);
  await act(async () => {
    if (input.checked !== checked) input.click();
  });
}

async function setValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter === undefined) throw new Error('native value setter unavailable');
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('SpeechGenerationPanel', () => {
  it('selects a compatible ready engine when the default engine needs setup', async () => {
    const view = await render(
      makeProps({
        modelStatus: [
          { modelId: 'faster-whisper-large-v3-turbo', state: 'ready' },
          { modelId: 'kokoro-82m', state: 'setup-required' },
          { modelId: 'chatterbox-en', state: 'ready' },
          { modelId: 'chatterbox-fa', state: 'incompatible' },
        ],
      }),
    );
    const engine = view.querySelector<HTMLSelectElement>('select[name="engine"]')!;
    expect(engine.value).toBe('chatterbox-en');
    expect([...engine.options].map((option) => option.value)).not.toContain('chatterbox-fa');
  });

  it('switches language and hides engines that do not support the selected language', async () => {
    const view = await render(makeProps());
    let options = [...view.querySelectorAll<HTMLSelectElement>('select[name="engine"] option')].map(
      (option) => option.textContent,
    );
    expect(options.join(' ')).toContain('Kokoro 82M');
    expect(options.join(' ')).toContain('Chatterbox English');
    expect(options.join(' ')).not.toContain('Chatterbox Persian');

    const language = view.querySelector<HTMLSelectElement>('select[name="language"]');
    expect(language).not.toBeNull();
    await act(async () => {
      language!.value = 'fa-IR';
      language!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    options = [...view.querySelectorAll<HTMLSelectElement>('select[name="engine"] option')].map(
      (option) => option.textContent,
    );
    expect(options.join(' ')).toContain('Chatterbox Persian');
    expect(options.join(' ')).not.toContain('Kokoro 82M');
    expect(options.join(' ')).not.toContain('Chatterbox English');
    expect(view.textContent).toContain('Chatterbox Persian Expressive by Ramin Mahmoodi');
    expect(view.textContent).toContain('CC-BY-NC-4.0 - for non-commercial use only');
    expect(view.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(view.querySelector<HTMLTextAreaElement>('textarea')?.dir).toBe('rtl');
  });

  it('distinguishes a setup-required engine from a ready engine and gives local setup guidance', async () => {
    const view = await render(
      makeProps({
        modelStatus: [
          { modelId: 'faster-whisper-large-v3-turbo', state: 'setup-required' },
          { modelId: 'kokoro-82m', state: 'ready' },
        ],
      }),
    );

    expect(view.textContent).toContain('Kokoro 82M');
    expect(view.textContent).toContain('Ready');
    expect(view.textContent).toContain('Speech-to-text setup required');
    expect(view.textContent?.toLowerCase()).toContain('local assets');
    expect(view.textContent).toContain('saved custom setup');
  });

  it('uses only registered audio assets and requires a reference for Persian speech', async () => {
    const view = await render(makeProps());
    const reference = view.querySelector<HTMLSelectElement>('select[name="referenceAssetId"]');
    expect(reference).not.toBeNull();
    expect([...reference!.options].map((option) => option.value)).toEqual([
      '',
      'asset-voice-one',
      'asset-music',
    ]);
    expect(view.textContent).toContain('Optional English reference');

    const language = view.querySelector<HTMLSelectElement>('select[name="language"]')!;
    await act(async () => {
      language.value = 'fa-IR';
      language.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(view.textContent).toContain('Persian reference required');
    expect(view.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

    await act(async () => {
      reference!.value = 'asset-voice-one';
      reference!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(view.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it('disables Kokoro references and clears reference consent when switching engines', async () => {
    const view = await render(makeProps());
    const engine = view.querySelector<HTMLSelectElement>('select[name="engine"]')!;
    await act(async () => {
      engine.value = 'chatterbox-en';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const reference = view.querySelector<HTMLSelectElement>('select[name="referenceAssetId"]')!;
    await act(async () => {
      reference.value = 'asset-voice-one';
      reference.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await setCheckbox('I have permission');
    expect(reference.value).toBe('asset-voice-one');
    expect(reference.disabled).toBe(false);

    await act(async () => {
      engine.value = 'kokoro-82m';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(reference.disabled).toBe(true);
    expect(reference.value).toBe('');
    const consent = [...view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.parentElement?.textContent?.includes('I have permission'),
    );
    expect(consent?.checked).toBe(false);
  });

  it('clears stale reference state when a ready engine becomes unavailable and Kokoro is selected automatically', async () => {
    const onGenerate = vi.fn<SpeechGenerationPanelProps['onGenerate']>(async () => ({
      availability: 'ready',
    }));
    const view = await render(makeProps({ onGenerate }));
    await setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, 'Hello there');
    const engine = view.querySelector<HTMLSelectElement>('select[name="engine"]')!;
    await act(async () => {
      engine.value = 'chatterbox-en';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await setValue(
      view.querySelector<HTMLSelectElement>('select[name="referenceAssetId"]')!,
      'asset-voice-one',
    );
    await setCheckbox('I have permission');
    await act(async () =>
      root?.render(
        <SpeechGenerationPanel
          {...makeProps({
            onGenerate,
            modelStatus: [
              { modelId: 'faster-whisper-large-v3-turbo', state: 'ready' },
              { modelId: 'kokoro-82m', state: 'ready' },
              { modelId: 'chatterbox-en', state: 'setup-required' },
              { modelId: 'chatterbox-fa', state: 'ready' },
            ],
          })}
        />,
      ),
    );
    expect(engine.value).toBe('kokoro-82m');
    expect(view.querySelector<HTMLSelectElement>('select[name="referenceAssetId"]')!.value).toBe(
      '',
    );
    await act(async () =>
      view
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(onGenerate.mock.calls[0]?.[1].referenceAssetId).toBeUndefined();
  });

  it('requires fresh consent and drops the reference when model status changes the effective engine', async () => {
    const onGenerate = vi.fn<SpeechGenerationPanelProps['onGenerate']>(async () => ({
      availability: 'ready',
    }));
    const view = await render(makeProps({ onGenerate }));
    await setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, 'Hello there');
    const engine = view.querySelector<HTMLSelectElement>('select[name="engine"]')!;
    await setValue(engine, 'chatterbox-en');
    const reference = view.querySelector<HTMLSelectElement>('select[name="referenceAssetId"]')!;
    await setValue(reference, 'asset-voice-one');
    await setCheckbox('I have permission');

    const renderStatus = async (chatterbox: 'ready' | 'setup-required') =>
      act(async () =>
        root?.render(
          <SpeechGenerationPanel
            {...makeProps({
              onGenerate,
              modelStatus: [
                { modelId: 'faster-whisper-large-v3-turbo', state: 'ready' },
                { modelId: 'kokoro-82m', state: 'ready' },
                { modelId: 'chatterbox-en', state: chatterbox },
                { modelId: 'chatterbox-fa', state: 'ready' },
              ],
            })}
          />,
        ),
      );

    await renderStatus('setup-required');
    expect(engine.value).toBe('kokoro-82m');
    await renderStatus('ready');
    expect(engine.value).toBe('chatterbox-en');
    expect(reference.value).toBe('');
    const consent = view.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(consent.checked).toBe(false);

    await act(async () =>
      view
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('requires reference voice rights consent before Generate', async () => {
    const onGenerate = vi.fn<SpeechGenerationPanelProps['onGenerate']>(async () => ({
      availability: 'ready',
    }));
    const view = await render(makeProps({ onGenerate }));
    const text = view.querySelector<HTMLTextAreaElement>('textarea')!;
    await setValue(text, 'Hello there');
    const form = view.querySelector('form')!;
    await act(async () =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(onGenerate).not.toHaveBeenCalled();

    await setCheckbox('I have permission');
    await act(async () =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(onGenerate).toHaveBeenCalledTimes(1);
    const [request, options] = onGenerate.mock.calls[0]!;
    expect(request).toMatchObject({ schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m' });
    expect(options).toMatchObject({
      consent: { acknowledged: true, purpose: 'general' },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('requires fresh consent when the selected reference asset changes', async () => {
    const view = await render(makeProps());
    await setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, 'Hello there');
    await setValue(
      view.querySelector<HTMLSelectElement>('select[name="engine"]')!,
      'chatterbox-en',
    );
    const reference = view.querySelector<HTMLSelectElement>('select[name="referenceAssetId"]')!;
    await setValue(reference, 'asset-voice-one');
    await setCheckbox('I have permission');
    const consent = view.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const generate = view.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(consent.checked).toBe(true);
    expect(generate.disabled).toBe(false);

    await setValue(reference, 'asset-music');

    expect(reference.value).toBe('asset-music');
    expect(consent.checked).toBe(false);
    expect(generate.disabled).toBe(true);
  });

  it('requires fresh consent when the language or engine changes', async () => {
    const view = await render(makeProps());
    await setValue(view.querySelector<HTMLTextAreaElement>('textarea')!, 'Hello there');
    await setValue(
      view.querySelector<HTMLSelectElement>('select[name="engine"]')!,
      'chatterbox-en',
    );
    const reference = view.querySelector<HTMLSelectElement>('select[name="referenceAssetId"]')!;
    await setValue(reference, 'asset-voice-one');
    const consent = view.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const generate = view.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await setCheckbox('I have permission');

    await setValue(view.querySelector<HTMLSelectElement>('select[name="language"]')!, 'fa-IR');
    expect(consent.checked).toBe(false);
    expect(generate.disabled).toBe(true);
    await setValue(reference, 'asset-voice-one');
    await setCheckbox('I have permission');
    expect(generate.disabled).toBe(false);

    await setValue(
      view.querySelector<HTMLSelectElement>('select[name="engine"]')!,
      'chatterbox-en',
    );
    expect(consent.checked).toBe(false);
  });

  it('keeps consent for the same reference when only the text changes', async () => {
    const view = await render(makeProps());
    const text = view.querySelector<HTMLTextAreaElement>('textarea')!;
    await setValue(text, 'Hello there');
    await setValue(
      view.querySelector<HTMLSelectElement>('select[name="engine"]')!,
      'chatterbox-en',
    );
    await setValue(
      view.querySelector<HTMLSelectElement>('select[name="referenceAssetId"]')!,
      'asset-voice-one',
    );
    await setCheckbox('I have permission');

    await setValue(text, 'A different script for the same voice');

    expect(view.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(view.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });

  it('passes the selected reference once and aborts the in-flight request on Cancel', async () => {
    let finish: ((value: SpeechGenerationResult) => void) | undefined;
    const onGenerate = vi.fn<SpeechGenerationPanelProps['onGenerate']>(
      () =>
        new Promise<SpeechGenerationResult>((resolve) => {
          finish = resolve;
        }),
    );
    const view = await render(makeProps({ onGenerate }));
    const text = view.querySelector<HTMLTextAreaElement>('textarea')!;
    const engine = view.querySelector<HTMLSelectElement>('select[name="engine"]')!;
    await act(async () => {
      engine.value = 'chatterbox-en';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const reference = view.querySelector<HTMLSelectElement>('select[name="referenceAssetId"]')!;
    await setValue(text, 'Hello there');
    await setValue(reference, 'asset-voice-one');
    await setCheckbox('I have permission');
    await act(async () =>
      view
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );

    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0]?.[1].referenceAssetId).toBe('asset-voice-one');
    expect(view.textContent).toContain('Generating');
    await clickButton('Cancel generation');
    expect(onGenerate.mock.calls[0]?.[1].signal.aborted).toBe(true);
    await act(async () => finish?.({ availability: 'ready' }));
  });

  it('keeps IME composition text intact and does not submit while composing', async () => {
    const onGenerate = vi.fn(async () => ({ availability: 'ready' as const }));
    const view = await render(makeProps({ onGenerate }));
    const text = view.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      text.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        text,
        'こん',
      );
      text.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: 'こん', isComposing: true }),
      );
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        text,
        'こんにちは',
      );
      text.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: 'こんにちは' }),
      );
      text.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: 'は', isComposing: false }),
      );
    });
    expect(text.value).toBe('こんにちは');
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('offers Add captions only when completed output has trusted word timings', async () => {
    const onAddCaptions = vi.fn();
    const onGenerate = vi.fn(async () => ({
      availability: 'ready' as const,
      timing: {
        durationUs: 1_000_000,
        timingSource: 'aligned' as const,
        words: [{ text: 'Hello', startUs: 0, endUs: 500_000 }],
      },
    }));
    const view = await render(makeProps({ onGenerate, onAddCaptions }));
    const text = view.querySelector<HTMLTextAreaElement>('textarea')!;
    await setValue(text, 'Hello');
    await setCheckbox('I have permission');
    await act(async () =>
      view
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(view.textContent).toContain('Add captions');
    await clickButton('Add captions');
    expect(onAddCaptions).toHaveBeenCalledTimes(1);
    expect(onAddCaptions).toHaveBeenCalledWith({
      durationUs: 1_000_000,
      timingSource: 'aligned',
      words: [{ text: 'Hello', startUs: 0, endUs: 500_000 }],
    });
  });

  it('does not offer Add captions for unavailable timing metadata', async () => {
    const view = await render(
      makeProps({
        onGenerate: async () => ({
          availability: 'ready',
          timing: { durationUs: 1_000_000, timingSource: 'unavailable', words: [] },
        }),
      }),
    );
    const text = view.querySelector<HTMLTextAreaElement>('textarea')!;
    await setValue(text, 'Hello');
    await setCheckbox('I have permission');
    await act(async () =>
      view
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(view.textContent).not.toContain('Add captions');
  });
});
