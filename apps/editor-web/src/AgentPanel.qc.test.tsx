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
import type { JoyAgentEngineClient, JoyAgentRunHost } from './joy-agent/engine-client.js';
import type { HostRpcHandlerContext, HostRpcJson, HostRpcMethod } from './joy-agent/host-rpc.js';
import type { ByokSessionStatus } from './joy-agent/protocol.js';
import { QC_HOST_TOOL_NAMES } from './joy-agent/qc-request-intent.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not lay out, so the chat's scroll-to-end call needs a stub.
Element.prototype.scrollIntoView = vi.fn();

/**
 * T-B04b: a quality-check request gets the QC host adapter, so the three QC
 * tools are advertised and answered. An ordinary edit never gets them. The
 * panel is driven through its real composer; only the model client is faked.
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

function context(): HostRpcHandlerContext {
  return {
    run: { runId: 'run-qc-1', epoch: 1 },
    requestId: 'request-1',
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
  };
}

/** A client that records the host each run starts with, then ends the run at once. */
function recordingClient() {
  const hosts: JoyAgentRunHost[] = [];
  const startRun = vi.fn((_request: unknown, host?: JoyAgentRunHost) => {
    if (host !== undefined) hosts.push(host);
    const iterator = (async function* () {
      // No events: the run ends as soon as the host has been handed over.
    })();
    return Object.assign(iterator, { run: { runId: 'run-qc-1', epoch: 1 } });
  });
  const client = {
    getStatus: () => CONNECTED,
    getMediaCapabilities: () => undefined,
    cancel: vi.fn(async () => undefined),
    startRun,
  } as unknown as JoyAgentEngineClient;
  return { client, hosts };
}

async function sendPrompt(client: JoyAgentEngineClient, prompt: string): Promise<void> {
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
  const textarea = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message Joy Code"]',
  );
  const send = container.querySelector<HTMLButtonElement>('button.joy-code-send');
  if (textarea === null || send === null) throw new Error('The Joy Code composer is missing');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setValue === undefined) throw new Error('No textarea value setter');
  act(() => {
    setValue.call(textarea, prompt);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    send.click();
  });
}

describe('AgentPanel: QC host adapter wiring', () => {
  it('passes the QC adapter and advertises the three QC tools for a quality-check request', async () => {
    const { client, hosts } = recordingClient();

    await sendPrompt(client, 'Run a quality check on my film');

    expect(hosts).toHaveLength(1);
    const host = hosts[0]!;
    for (const name of QC_HOST_TOOL_NAMES) {
      expect(host.allowedToolNames).toContain(name);
      expect(host.methods[name], name).toBeDefined();
    }
    expect(host.allowedToolNames).toContain('read_project_context');
    expect(host.allowedToolNames).toContain('validate_proposal');

    // The adapter is connected, and it refuses honestly: this build has no
    // composition renderer, so there is no report and no frame to send.
    const read = host.methods['qc_report_read'] as HostRpcMethod<HostRpcJson, HostRpcJson>;
    const report = await read.execute(
      read.parseArgs({ reportId: 'latest', includeFindings: true }),
      context(),
    );
    expect(report).toMatchObject({ ok: false, code: 'JOY_AGENT_QC_REPORT_UNAVAILABLE' });
    const view = host.methods['media_frames_view'] as HostRpcMethod<HostRpcJson, HostRpcJson>;
    const refused = await view.execute(
      view.parseArgs({ reportId: 'latest', frameIds: ['timeline-frame-0'], reason: 'Look.' }),
      context(),
    );
    expect(refused).toMatchObject({ ok: false, code: 'JOY_AGENT_QC_FRAME_NOT_LISTED' });
  });

  it('keeps the QC tools away from an ordinary edit', async () => {
    const { client, hosts } = recordingClient();

    await sendPrompt(client, 'Trim the first clip by two seconds');

    expect(hosts).toHaveLength(1);
    const host = hosts[0]!;
    for (const name of QC_HOST_TOOL_NAMES) {
      expect(host.allowedToolNames).not.toContain(name);
      expect(host.methods[name], name).toBeUndefined();
    }
  });
});
