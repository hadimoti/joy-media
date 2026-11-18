// @vitest-environment jsdom
import { act } from 'react';
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

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not lay out, so the chat's scroll-to-end call needs a stub.
Element.prototype.scrollIntoView = vi.fn();

/**
 * Defect 164: a message sent while the model capability is untested must not
 * be shown as sent. The typed text stays in the composer, the notice is shown,
 * and the same text can be sent again once a model has been tested.
 */

const UNTESTED: ByokSessionStatus = {
  provider: 'openai-compatible',
  modelId: 'gpt-test',
  capability: 'untested',
};
const TOOL_LOOP: ByokSessionStatus = { ...UNTESTED, capability: 'tool-loop' };
const PROMPT = 'Trim the first clip by two seconds';
const NOTICE = 'The model capability is untested. Test a model in Agent Settings.';

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

/** A client that reports the status the test sets; a run ends at once with no events. */
function controllableClient(status: { current: ByokSessionStatus }) {
  const startRun = vi.fn(() => {
    const iterator = (async function* () {
      // No events: the run ends as soon as it starts.
    })();
    return Object.assign(iterator, { run: { runId: 'run-untested-1', epoch: 1 } });
  });
  const client = {
    getStatus: () => status.current,
    getMediaCapabilities: () => undefined,
    cancel: vi.fn(async () => undefined),
    startRun,
  } as unknown as JoyAgentEngineClient;
  return { client, startRun };
}

function renderPanel(client: JoyAgentEngineClient): void {
  const project = buildReferenceSpikeProject();
  const session = new EditorSession(memoryStorage(), project, INITIAL_EDITOR_PROJECT);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
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
      />,
    ),
  );
}

function composer(): { textarea: HTMLTextAreaElement; send: HTMLButtonElement } {
  const textarea = container?.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message Joy Code"]',
  );
  const send = container?.querySelector<HTMLButtonElement>('button.joy-code-send');
  if (textarea === null || textarea === undefined || send === null || send === undefined) {
    throw new Error('The Joy Code composer is missing');
  }
  return { textarea, send };
}

function typeText(text: string): void {
  const { textarea } = composer();
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (setValue === undefined) throw new Error('No textarea value setter');
  act(() => {
    setValue.call(textarea, text);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function clickSend(): Promise<void> {
  const { send } = composer();
  expect(send.disabled).toBe(false);
  await act(async () => {
    send.click();
  });
}

function userBubbles(): string[] {
  // The body is the paragraph; the speaker label ("You") is a separate strong element.
  return Array.from(container?.querySelectorAll('.joy-code-message.is-user p') ?? []).map(
    (paragraph) => paragraph.textContent ?? '',
  );
}

function assistantTexts(): string[] {
  return Array.from(container?.querySelectorAll('.joy-code-message.is-assistant') ?? []).map(
    (bubble) => bubble.textContent ?? '',
  );
}

describe('AgentPanel: a message sent while the model is untested', () => {
  it('keeps the typed text in the composer, adds no user bubble, and shows the notice', async () => {
    const status = { current: UNTESTED };
    const { client, startRun } = controllableClient(status);
    renderPanel(client);

    typeText(PROMPT);
    await clickSend();

    expect(composer().textarea.value).toBe(PROMPT);
    expect(userBubbles()).toEqual([]);
    expect(assistantTexts().some((text) => text.includes(NOTICE))).toBe(true);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('sends the kept text once a model has been tested', async () => {
    const status = { current: UNTESTED };
    const { client, startRun } = controllableClient(status);
    renderPanel(client);

    typeText(PROMPT);
    await clickSend();
    expect(startRun).not.toHaveBeenCalled();

    status.current = TOOL_LOOP;
    await clickSend();

    expect(startRun).toHaveBeenCalledTimes(1);
    expect(userBubbles()).toEqual([PROMPT]);
    expect(composer().textarea.value).toBe('');
  });
});
