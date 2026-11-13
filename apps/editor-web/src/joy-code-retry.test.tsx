// @vitest-environment jsdom
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentIntent } from './agent-panel-intents.js';
import type { LivingLooksRunInput } from './LivingLooksPanel.js';
import { JoyCodeFailureCard } from './joy-code-failure-card.js';
import { JOY_CODE_MESSAGES } from './joy-code-messages.js';
import {
  createJoyCodeRetryTargets,
  joyCodeMessageWithoutRetry,
  runJoyCodeRetry,
  type JoyCodeRetryRunners,
} from './joy-code-retry.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LOOK_APPLY: LivingLooksRunInput = {
  kind: 'apply',
  definitionId: 'warm-film',
  definitionVersion: 1,
  entityBindings: { title: 'object-1' },
  controlValues: { strength: 0.5 },
};

const LOOK_BAKE = {
  kind: 'apply',
  definitionId: 'beat-pulse',
  definitionVersion: 2,
  entityBindings: { title: 'object-2' },
  controlValues: { strength: 0.8 },
} satisfies LivingLooksRunInput;

const INTENT = { id: 'split-trim', label: 'Split and trim' } as unknown as AgentIntent;

function recordingRunners() {
  return {
    prompt: vi.fn<(prompt: string) => void>(),
    recipe: vi.fn<(skillId: string) => void>(),
    agentLook: vi.fn<(prompt: string) => void>(),
    look: vi.fn<(request: LivingLooksRunInput) => void>(),
    bake: vi.fn<(request: LivingLooksRunInput) => void>(),
    plan: vi.fn<(intent: AgentIntent, threadId: string) => void>(),
  } satisfies Record<keyof JoyCodeRetryRunners, unknown>;
}

describe('Joy Code retry targets', () => {
  it('re-runs an audio bake failure with the bake request it saved', () => {
    const targets = createJoyCodeRetryTargets();
    targets.save('message-bake', { kind: 'bake', request: LOOK_BAKE });
    const runners = recordingRunners();

    runJoyCodeRetry(targets.get('message-bake')!, runners);

    expect(runners.bake).toHaveBeenCalledTimes(1);
    expect(runners.bake.mock.calls[0]![0]).toBe(LOOK_BAKE);
    expect(runners.look).not.toHaveBeenCalled();
  });

  it('re-plans a plan failure with its saved intent on its own thread', () => {
    const targets = createJoyCodeRetryTargets();
    targets.save('message-plan', { kind: 'plan', intent: INTENT, threadId: 'thread-7' });
    const runners = recordingRunners();

    runJoyCodeRetry(targets.get('message-plan')!, runners);

    expect(runners.plan).toHaveBeenCalledWith(INTENT, 'thread-7');
    expect(runners.plan.mock.calls[0]![0]).toBe(INTENT);
    expect(runners.recipe).not.toHaveBeenCalled();
  });

  it('re-runs a recipe failure with the saved recipe, not a later one', () => {
    const targets = createJoyCodeRetryTargets();
    targets.save('message-recipe-1', { kind: 'recipe', skillId: 'cut-to-beat' });
    targets.save('message-recipe-2', { kind: 'recipe', skillId: 'warm-grade' });
    const runners = recordingRunners();

    runJoyCodeRetry(targets.get('message-recipe-1')!, runners);

    expect(runners.recipe).toHaveBeenCalledExactlyOnceWith('cut-to-beat');
  });

  it('re-runs a Look failure with the exact Look request, and an agent Look with its prompt', () => {
    const targets = createJoyCodeRetryTargets();
    targets.save('message-look', { kind: 'look', request: LOOK_APPLY });
    targets.save('message-agent-look', { kind: 'agent-look', prompt: 'soften the entrance' });
    const runners = recordingRunners();

    runJoyCodeRetry(targets.get('message-look')!, runners);
    runJoyCodeRetry(targets.get('message-agent-look')!, runners);

    expect(runners.look).toHaveBeenCalledTimes(1);
    expect(runners.look.mock.calls[0]![0]).toBe(LOOK_APPLY);
    expect(runners.agentLook).toHaveBeenCalledExactlyOnceWith('soften the entrance');
  });

  it('re-runs a prompt failure with the prompt that failed', () => {
    const targets = createJoyCodeRetryTargets();
    targets.save('message-prompt', { kind: 'prompt', prompt: 'trim the intro' });
    const runners = recordingRunners();

    runJoyCodeRetry(targets.get('message-prompt')!, runners);

    expect(runners.prompt).toHaveBeenCalledExactlyOnceWith('trim the intro');
  });

  it('gives a failure with no saved request no retry target', () => {
    const targets = createJoyCodeRetryTargets();
    targets.save('message-look', { kind: 'look', request: LOOK_APPLY });

    expect(targets.get('message-execution')).toBeUndefined();
  });

  it('turns Try again into Dismiss when the failure has no saved request', () => {
    expect(joyCodeMessageWithoutRetry(JOY_CODE_MESSAGES['adapter-failed']).action).toEqual({
      label: 'Dismiss',
      kind: 'dismiss',
    });
    expect(joyCodeMessageWithoutRetry(JOY_CODE_MESSAGES.JOY_AGENT_AUTH_FAILED).action).toEqual(
      JOY_CODE_MESSAGES.JOY_AGENT_AUTH_FAILED.action,
    );
    expect(joyCodeMessageWithoutRetry(JOY_CODE_MESSAGES.cancelled).action.kind).toBe('dismiss');
  });
});

describe('Joy Code failure card retry button', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  async function render(node: ReactNode): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
    return container;
  }

  it('the Try again button hands the saved bake request to the bake runner', async () => {
    const targets = createJoyCodeRetryTargets();
    targets.save('message-bake', { kind: 'bake', request: LOOK_BAKE });
    const runners = recordingRunners();
    const saved = targets.get('message-bake')!;
    const rendered = await render(
      <JoyCodeFailureCard
        message={JOY_CODE_MESSAGES['audio-not-prepared']}
        onRetry={() => runJoyCodeRetry(saved, runners)}
      />,
    );

    await act(async () => {
      rendered.querySelector('button')!.click();
    });

    expect(runners.bake).toHaveBeenCalledTimes(1);
    expect(runners.bake.mock.calls[0]![0]).toBe(LOOK_BAKE);
  });

  it('a failure with no saved request shows Dismiss and no Try again', async () => {
    // The panel passes no onRetry for a failure without a saved request.
    const rendered = await render(
      <JoyCodeFailureCard
        message={joyCodeMessageWithoutRetry(JOY_CODE_MESSAGES.JOY_AGENT_INVALID_PROPOSAL)}
      />,
    );

    const buttons = rendered.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe('Dismiss');
    expect(rendered.textContent).not.toContain('Try again');
  });
});
