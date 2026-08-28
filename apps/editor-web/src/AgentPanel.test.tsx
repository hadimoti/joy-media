// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildEditorContext,
  type ApprovalDecision,
  type ProjectRevisionId,
} from '@joy-media/agent-tools';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { DEFAULT_AGENT_SETTINGS } from './agent-settings.js';
import type { EditorSession } from './editor-session.js';
import {
  AgentPanel,
  ProviderApprovalDetails,
  selectJoyCodePendingApproval,
} from './AgentPanel.js';
import {
  BrowserControlPlaneClient,
  type BrowserJoyCodeReasoningResponse,
} from './control-plane-client.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(async () => {
  const entries = mounted.splice(0);
  await act(async () => {
    for (const { root } of entries) root.unmount();
  });
  for (const { container } of entries) container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AgentPanel approval selection', () => {
  it('prefers provider preflight approval over generic manual provider decisions', () => {
    const generic = decision({
      id: 'approval-generic',
      reason: 'Manual approval required for provider.generate',
    });
    const provider = decision({
      id: 'approval-provider-sha256:abc123',
      reason: 'Provider approval required for edge-tts speech.synthesize',
      providerApproval: {
        providerId: 'edge-tts',
        capability: 'speech.synthesize',
        requestDigest: 'sha256:abc123',
      },
    });

    expect(selectJoyCodePendingApproval([generic, provider])).toBe(provider);
  });

  it('keeps blocked and generic approvals intact when no provider preflight is present', () => {
    const generic = decision({ id: 'approval-generic', reason: 'Generic manual approval' });
    const blocked = decision({
      id: 'approval-blocked',
      reason: 'Blocked by policy',
      decision: 'blocked',
    });

    expect(selectJoyCodePendingApproval([generic])).toBe(generic);
    expect(selectJoyCodePendingApproval([generic, blocked])).toBe(blocked);
  });

  it('renders provider approval details for Joy Code review', () => {
    const provider = decision({
      id: 'approval-provider-sha256:abc123',
      reason: 'Provider approval required for edge-tts speech.synthesize',
      providerApproval: {
        providerId: 'edge-tts',
        capability: 'speech.synthesize',
        requestDigest: 'sha256:abc123',
      },
    });

    const html = renderToStaticMarkup(<ProviderApprovalDetails approval={provider} />);

    expect(html).toContain('Provider');
    expect(html).toContain('edge-tts');
    expect(html).toContain('Capability');
    expect(html).toContain('speech.synthesize');
    expect(html).toContain('Cost cap');
    expect(html).toContain('0.00 USD');
    expect(html).toContain('sha256:abc123');
  });
});

describe('AgentPanel remote reasoning lifecycle', () => {
  it('discards a late response after the project revision changes', async () => {
    vi.useFakeTimers();
    const pendingResponse = deferred<BrowserJoyCodeReasoningResponse>();
    const reasoning = vi
      .spyOn(BrowserControlPlaneClient.prototype, 'joyCodeReasoning')
      .mockReturnValue(pendingResponse.promise);
    const project = buildReferenceSpikeProject();
    const view = await mountAgentPanel(project, 'revision-a');

    await submit(view.container, 'Give me a bounded critique');
    expect(reasoning).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.root.render(panel(project, 'revision-b'));
    });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'stale response was discarded',
    );

    await act(async () => {
      pendingResponse.resolve(reasoningResponse('late response'));
      await settlePromises();
    });

    expect(view.container.textContent).not.toContain('late response');
    expect(view.container.querySelector('[aria-label="Proposed timeline plan"]')).toBeNull();
  });

  it('blocks duplicate submits before React has rendered the busy state', async () => {
    vi.useFakeTimers();
    const pendingResponse = deferred<BrowserJoyCodeReasoningResponse>();
    const reasoning = vi
      .spyOn(BrowserControlPlaneClient.prototype, 'joyCodeReasoning')
      .mockReturnValue(pendingResponse.promise);
    const project = buildReferenceSpikeProject();
    const view = await mountAgentPanel(project, 'revision-a');

    const send = view.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    await act(async () => {
      setComposerValue(view.container, 'Give me a bounded critique');
      send.click();
      send.click();
      await vi.advanceTimersByTimeAsync(321);
    });

    expect(reasoning).toHaveBeenCalledTimes(1);
    pendingResponse.resolve(reasoningResponse('one response'));
    await act(settlePromises);
  });

  it('surfaces reasoning failures through an assertive alert', async () => {
    vi.useFakeTimers();
    vi.spyOn(BrowserControlPlaneClient.prototype, 'joyCodeReasoning').mockRejectedValue(
      new Error('Reasoning service timed out'),
    );
    const project = buildReferenceSpikeProject();
    const view = await mountAgentPanel(project, 'revision-a');

    await submit(view.container, 'Give me a bounded critique');

    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.getAttribute('aria-live')).toBe('assertive');
    expect(alert?.textContent).toContain('Reasoning service timed out');
  });

  it('ignores a response that resolves after unmount', async () => {
    vi.useFakeTimers();
    const pendingResponse = deferred<BrowserJoyCodeReasoningResponse>();
    vi.spyOn(BrowserControlPlaneClient.prototype, 'joyCodeReasoning').mockReturnValue(
      pendingResponse.promise,
    );
    const project = buildReferenceSpikeProject();
    const view = await mountAgentPanel(project, 'revision-a');

    await submit(view.container, 'Give me a bounded critique');
    await act(async () => view.root.unmount());
    mounted.splice(mounted.indexOf(view), 1);

    await act(async () => {
      pendingResponse.resolve(reasoningResponse('late response after unmount'));
      await settlePromises();
    });
    expect(view.container.textContent).toBe('');
  });
});

function panel(project: ReturnType<typeof buildReferenceSpikeProject>, revision: ProjectRevisionId) {
  return (
    <AgentPanel
      project={project}
      selectedClipIds={[]}
      playheadUs={0}
      agentContext={buildEditorContext(project)}
      onUndo={() => undefined}
      session={{ projectRevisionId: revision } as EditorSession}
      settings={{ ...DEFAULT_AGENT_SETTINGS, reasoningModel: 'mistral-small-latest' }}
    />
  );
}

async function mountAgentPanel(
  project: ReturnType<typeof buildReferenceSpikeProject>,
  revision: ProjectRevisionId,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const view = { root, container };
  mounted.push(view);
  await act(async () => root.render(panel(project, revision)));
  return view;
}

async function submit(container: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    setComposerValue(container, value);
    container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click();
    await vi.advanceTimersByTimeAsync(321);
    await settlePromises();
  });
}

function setComposerValue(container: HTMLElement, value: string): void {
  const composer = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Joy Code"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(composer, value);
  composer.dispatchEvent(new Event('input', { bubbles: true }));
}

function reasoningResponse(summary: string): BrowserJoyCodeReasoningResponse {
  return {
    responseVersion: 1,
    requestId: 'request-1',
    brief: { summary, rationale: 'Test rationale', evidenceReferences: [] },
    provider: {
      providerId: 'mistral',
      modelId: 'mistral-small-latest',
      decisionRef: 'decision-1',
      briefRef: 'brief-1',
      requestDigest: 'sha256:test',
      dataLeavesDevice: false,
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function decision(overrides: {
  readonly id: string;
  readonly reason: string;
  readonly decision?: ApprovalDecision['decision'];
  readonly providerApproval?: ApprovalDecision['request']['providerApproval'];
}): ApprovalDecision {
  return {
    decision: overrides.decision ?? 'requires-manual',
    reason: overrides.reason,
    request: {
      id: overrides.id,
      stepId: 'tts-step',
      reason: 'paid-generation',
      description: overrides.reason,
      estimatedCost: { amount: '0.00', currency: 'USD' },
      privacyImpact: {
        dataLeavesDevice: true,
        providerId: 'edge-tts',
        dataTypes: ['text data'],
        retentionDisclosure: 'Text is sent to Microsoft Edge online TTS for synthesis',
      },
      isReversible: true,
      status: 'pending',
      ...(overrides.providerApproval === undefined
        ? {}
        : { providerApproval: overrides.providerApproval }),
    },
  };
}
