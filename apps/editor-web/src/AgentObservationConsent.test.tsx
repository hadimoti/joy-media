// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentObservationConsent,
  type AgentObservationConsentProps,
  type AgentObservationConsentScope,
} from './AgentObservationConsent.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scope: AgentObservationConsentScope = Object.freeze({
  providerName: 'OpenRouter',
  modelName: 'openai/gpt-5.6',
  availability: 'ready',
  selectedEvidenceCount: 3,
  modalities: Object.freeze(['image', 'audio'] as const),
  range: Object.freeze({ domain: 'composition' as const, startUs: 250_000, endUs: 4_000_000 }),
  maxRequests: 2,
  maxBytes: 2 * 1_024 * 1_024,
  estimatedCost: Object.freeze({ amount: 0.0145, currency: 'USD' }),
  policyHref: 'https://openrouter.ai/privacy',
});

function props(
  overrides: Partial<AgentObservationConsentProps> = {},
): AgentObservationConsentProps {
  return {
    scope,
    onApprove: () => undefined,
    onNarrow: () => undefined,
    onCancel: () => undefined,
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('AgentObservationConsent', () => {
  it('renders only redacted scope data and never reflects supplied secret or media fields', () => {
    const privateFields = {
      apiKey: 'sk-this-must-never-render',
      endpoint: 'https://provider.example/v1/chat/completions',
      sourceUrl: 'https://private.example/raw-video.mp4',
      sourcePath: 'C:\\private\\source.mov',
      evidenceBytes: new Uint8Array([1, 2, 3]),
      evidenceIds: ['frame-keep-private'],
    };
    const markup = renderToStaticMarkup(
      <AgentObservationConsent
        {...props({
          scope: { ...scope, ...privateFields } as unknown as AgentObservationConsentScope,
          direction: 'rtl',
          narrow: true,
          reducedMotion: true,
        })}
      />,
    );

    expect(markup).toContain('data-agent-observation-consent="invalid"');
    expect(markup).toContain('Nothing has been shared.');
    expect(markup).not.toContain(privateFields.apiKey);
    expect(markup).not.toContain(privateFields.endpoint);
    expect(markup).not.toContain(privateFields.sourceUrl);
    expect(markup).not.toContain(privateFields.sourcePath);
    expect(markup).not.toContain('frame-keep-private');
  });

  it('has no mount-time approval and emits one frozen redacted scope per intentional action', async () => {
    const onApprove = vi.fn();
    const onNarrow = vi.fn();
    const onCancel = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const rendered = container;

    await act(async () => {
      root?.render(<AgentObservationConsent {...props({ onApprove, onNarrow, onCancel })} />);
    });

    expect(onApprove).not.toHaveBeenCalled();
    expect(onNarrow).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(rendered.querySelector('[role="status"]')?.textContent).toContain(
      'Ready for your decision',
    );
    expect(rendered.querySelector('a')?.getAttribute('href')).toBe('https://openrouter.ai/privacy');
    expect(rendered.textContent).toContain(
      'Your provider may charge for or retain request logs under its own policy.',
    );

    const buttons = rendered.querySelectorAll<HTMLButtonElement>('button');
    expect(buttons).toHaveLength(3);
    await act(async () => {
      buttons[0]?.click();
      buttons[1]?.click();
      buttons[2]?.click();
      rendered
        .querySelector<HTMLElement>('[data-agent-observation-consent="true"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onNarrow).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(2);
    for (const callback of [onApprove, onNarrow, onCancel]) {
      const received = callback.mock.calls[0]?.[0] as AgentObservationConsentScope;
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received.modalities)).toBe(true);
      expect(Object.isFrozen(received.range)).toBe(true);
      expect(received).not.toHaveProperty('apiKey');
      expect(received).not.toHaveProperty('sourceUrl');
      expect(received).not.toHaveProperty('evidenceIds');
    }
  });

  it('distinguishes an availability probe from consent and does not enable approval while probing', async () => {
    const onApprove = vi.fn();
    const onNarrow = vi.fn();
    const onCancel = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <AgentObservationConsent
          {...props({
            scope: { ...scope, availability: 'probing', estimatedCost: 'unknown' },
            onApprove,
            onNarrow,
            onCancel,
          })}
        />,
      );
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    expect(buttons[0]?.disabled).toBe(true);
    expect(container.textContent).toContain('Checking availability');
    expect(container.textContent).toContain('Nothing has been shared.');
    expect(container.textContent).toContain('Unavailable — check provider pricing');

    await act(async () => {
      buttons[0]?.click();
      buttons[1]?.click();
      buttons[2]?.click();
    });

    expect(onApprove).not.toHaveBeenCalled();
    expect(onNarrow).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('uses safe RTL and narrow classes without exposing a policy link that is not a policy page', () => {
    const { policyHref: _policyHref, ...compatibleProviderScope } = scope;
    const validMarkup = renderToStaticMarkup(
      <AgentObservationConsent
        {...props({
          direction: 'rtl',
          narrow: true,
          reducedMotion: true,
        })}
      />,
    );
    const invalidPolicyMarkup = renderToStaticMarkup(
      <AgentObservationConsent
        {...props({
          scope: { ...scope, policyHref: 'https://private.example/policy/raw-video.mp4' },
        })}
      />,
    );
    const compatibleProviderMarkup = renderToStaticMarkup(
      <AgentObservationConsent {...props({ scope: compatibleProviderScope })} />,
    );

    expect(validMarkup).toContain(
      'class="agent-observation-consent is-ready is-narrow is-rtl is-reduced-motion"',
    );
    expect(validMarkup).toContain('dir="rtl"');
    expect(invalidPolicyMarkup).toContain('data-agent-observation-consent="invalid"');
    expect(invalidPolicyMarkup).not.toContain('raw-video.mp4');
    expect(invalidPolicyMarkup).not.toContain('Read the provider policy');
    expect(compatibleProviderMarkup).toContain(
      'Provider policy link unavailable for this compatible provider.',
    );
    expect(compatibleProviderMarkup).not.toContain('Read the provider policy');
  });
});
