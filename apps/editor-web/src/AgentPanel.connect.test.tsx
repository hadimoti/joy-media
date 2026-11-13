// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEditorContext } from '@joy-media/agent-tools';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { AgentPanel } from './AgentPanel.js';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type { ByokSessionStatus } from './joy-agent/protocol.js';
import { CONNECT_MODEL_FIRST_TITLE } from './joy-code-run-gate.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not lay out, so the chat's scroll-to-end call needs a stub.
Element.prototype.scrollIntoView = vi.fn();

/**
 * T-J02 review: the connect and disconnect flow through the real AgentPanel.
 * The model status is the only thing that changes; the panel is re-rendered
 * on the same root, as a connect or a disconnect does in the app, with no reload.
 */

const CONNECTED: ByokSessionStatus = {
  provider: 'openai-compatible',
  modelId: 'gpt-test',
  capability: 'tool-loop',
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function renderInto(element: ReactElement) {
  if (container === undefined || root === undefined) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root?.render(element));
}

/** A client whose status the test changes; the panel reads it on each render. */
function controllableClient(status: { current: ByokSessionStatus | undefined }) {
  return {
    getStatus: () => status.current,
    cancel: vi.fn(async () => undefined),
  } as unknown as JoyAgentEngineClient;
}

function tab(label: string): HTMLButtonElement {
  const found = Array.from(
    container?.querySelectorAll<HTMLButtonElement>('.joy-code-capability') ?? [],
  ).find((candidate) => candidate.textContent?.trim().startsWith(label));
  if (found === undefined) throw new Error(`No composer tab "${label}"`);
  return found;
}

function runButtons(): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>('.joy-code-recipe-run') ?? []);
}

function improveButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>(
    'button[aria-label="Improve project"]',
  );
  if (button === null || button === undefined) throw new Error('No Improve project button');
  return button;
}

function connectControls(): HTMLElement[] {
  return Array.from(
    container?.querySelectorAll<HTMLElement>(
      `[role="button"][aria-label="${CONNECT_MODEL_FIRST_TITLE}"]`,
    ) ?? [],
  );
}

function chatMessageCount(): number {
  return container?.querySelectorAll('.joy-code-message').length ?? 0;
}

describe('AgentPanel: connect and disconnect without a reload', () => {
  it('disables the controls while disconnected, enables them when connected, and disables them again', () => {
    const status: { current: ByokSessionStatus | undefined } = { current: undefined };
    const project = buildReferenceSpikeProject();
    const session = new EditorSession(memoryStorage(), project, INITIAL_EDITOR_PROJECT);
    const onOpenSettings = vi.fn();
    const client = controllableClient(status);
    // A new element each time: React skips a re-render when it gets the same element.
    const panel = () => (
      <AgentPanel
        project={project}
        selectedClipIds={[]}
        playheadUs={0}
        agentContext={buildEditorContext(project)}
        onUndo={() => undefined}
        session={session}
        settings={DEFAULT_AGENT_POLICY}
        storage={memoryStorage() as never}
        joyAgentEngineClient={client}
        creativeBriefOptedIn
        creativeBriefRunner={() => new Promise(() => undefined)}
        onOpenSettings={onOpenSettings}
      />
    );

    // Disconnected: Run and Improve are disabled and say what to do.
    renderInto(panel());
    act(() => tab('Recipes').click());
    expect(runButtons().length).toBeGreaterThan(0);
    for (const button of runButtons()) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(CONNECT_MODEL_FIRST_TITLE);
    }
    const before = chatMessageCount();
    act(() => runButtons()[0]!.click());
    expect(chatMessageCount()).toBe(before);

    act(() => tab('Creative Brief').click());
    expect(improveButton().disabled).toBe(true);
    expect(improveButton().title).toBe(CONNECT_MODEL_FIRST_TITLE);
    act(() => improveButton().click());
    expect(chatMessageCount()).toBe(before);

    // A click on the recipe card body opens settings once.
    act(() => container?.querySelector<HTMLElement>('.joy-code-recipe-copy strong')?.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    // The connect button is the keyboard and screen reader path; it opens settings once more.
    expect(connectControls().length).toBeGreaterThan(0);
    act(() => connectControls()[0]!.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(2);

    // Connected: the same panel, re-rendered on the same root, enables the controls.
    status.current = CONNECTED;
    renderInto(panel());
    act(() => tab('Creative Brief').click());
    expect(improveButton().disabled).toBe(false);
    expect(improveButton().title).toBe('');
    expect(connectControls()).toHaveLength(0);
    act(() => tab('Recipes').click());
    expect(runButtons().some((button) => !button.disabled)).toBe(true);
    expect(runButtons().every((button) => button.title === '')).toBe(true);

    // Disconnected again: the controls go back to disabled, with no reload.
    status.current = undefined;
    renderInto(panel());
    act(() => tab('Recipes').click());
    for (const button of runButtons()) expect(button.disabled).toBe(true);
    act(() => tab('Creative Brief').click());
    expect(improveButton().disabled).toBe(true);
    expect(connectControls().length).toBeGreaterThan(0);
  });
});
