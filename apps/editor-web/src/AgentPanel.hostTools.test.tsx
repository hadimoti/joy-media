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
import { JOY_AGENT_HOST_TOOL_NAMES } from './joy-agent/host-tool-contract.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type { JoyAgentObservationAdapterFactory } from './joy-agent/observation-host-factory.js';
import type { JoyAgentObservationHostBridge } from './joy-agent/observation-tool-adapter.js';
import type { ByokSessionStatus } from './joy-agent/protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not lay out, so the chat's scroll-to-end call needs a stub.
Element.prototype.scrollIntoView = vi.fn();

/**
 * The model must only be offered host tools that this panel can answer. The
 * generation and QC tools are catalog-only here, so they must never reach the
 * model through the real composer send path.
 */

const CONNECTED: ByokSessionStatus = {
  provider: 'openai-compatible',
  modelId: 'gpt-test',
  capability: 'tool-loop',
};

const NOT_OFFERED_IN_THIS_PANEL = [
  'generate_media',
  'attach_generated_media',
  'qc_report_read',
  'media_frames_view',
  'media_contact_sheet',
] as const;

const ORDINARY_PROMPT = 'make the opening feel calmer';
// Routes to the observation path: taskKind 'asset-edit' with a model connected.
const MEDIA_PROMPT = 'import the new video clip';

type CapturedHost = { readonly allowedToolNames?: readonly string[] } | undefined;

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

/**
 * A client that answers only the status and records the host handed to
 * startRun. startRun then throws, so the panel takes its normal failure path
 * without a Worker; the test needs nothing past the host handoff.
 */
function recordingClient() {
  const captured: { host: CapturedHost; called: boolean } = { host: undefined, called: false };
  const startRun = vi.fn((_request: unknown, host: CapturedHost) => {
    captured.host = host;
    captured.called = true;
    throw new Error('test: run not started');
  });
  const client = {
    getStatus: () => CONNECTED,
    cancel: vi.fn(async () => undefined),
    startRun,
  } as unknown as JoyAgentEngineClient;
  return { client, captured };
}

function observationFactory(): JoyAgentObservationAdapterFactory {
  // The host only reads these tools lazily, so an empty adapter is enough to
  // take the observation path that offers media_* tools.
  const bridge = { tools: {} } as unknown as JoyAgentObservationHostBridge;
  return { create: vi.fn(() => bridge) } as unknown as JoyAgentObservationAdapterFactory;
}

function typeIntoComposer(text: string): void {
  const textarea = container?.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message Joy Code"]',
  );
  if (textarea === null || textarea === undefined) throw new Error('No Joy Code composer');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The Joy Code composer's send button; the Looks composer has its own hidden `.joy-code-send`. */
function sendButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>(
    '.joy-code-input button.joy-code-send[aria-label="Send message"]',
  );
  if (button === null || button === undefined) throw new Error('No Joy Code send button');
  return button;
}

describe('AgentPanel: host tools offered to the model', () => {
  it('offers no generation or QC tool for an ordinary prompt', async () => {
    const { client, captured } = recordingClient();
    const project = buildReferenceSpikeProject();
    const session = new EditorSession(memoryStorage(), project, INITIAL_EDITOR_PROJECT);
    renderInto(
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
        onOpenSettings={() => undefined}
      />,
    );

    typeIntoComposer(ORDINARY_PROMPT);
    act(() => sendButton().click());
    await vi.waitFor(() => expect(captured.called).toBe(true));

    const offered = captured.host?.allowedToolNames ?? [];
    expect(offered.length).toBeGreaterThan(0);
    for (const name of NOT_OFFERED_IN_THIS_PANEL) expect(offered).not.toContain(name);
  });

  it('on the observation path offers every other host tool and none of the unregistered ones', async () => {
    const { client, captured } = recordingClient();
    const project = buildReferenceSpikeProject();
    const session = new EditorSession(memoryStorage(), project, INITIAL_EDITOR_PROJECT);
    renderInto(
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
        observationAdapterFactory={observationFactory()}
        creativeBriefOptedIn
        creativeBriefRunner={() => new Promise(() => undefined)}
        onOpenSettings={() => undefined}
      />,
    );

    typeIntoComposer(MEDIA_PROMPT);
    act(() => sendButton().click());
    await vi.waitFor(() => expect(captured.called).toBe(true));

    const offered = captured.host?.allowedToolNames ?? [];
    // Proves this really is the observation path, not the legacy list.
    expect(offered).toContain('media_describe');
    for (const name of NOT_OFFERED_IN_THIS_PANEL) expect(offered).not.toContain(name);
    // Every other host tool is offered exactly as before.
    expect(offered).toEqual(
      JOY_AGENT_HOST_TOOL_NAMES.filter(
        (name) => !(NOT_OFFERED_IN_THIS_PANEL as readonly string[]).includes(name),
      ),
    );
  });
});
