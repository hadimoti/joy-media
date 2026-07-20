import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { workflowToJson } from './authoring.js';
import type { JoyWorkflow } from './definition.js';
import { WORKFLOW_FORMAT_VERSION } from './definition.js';
import { runWorkflowHeadless } from './headless.js';
import { buildNodeLibrary } from './library.js';

/** A workflow using only port-free/port-backed library nodes: value → approval → metadata. */
const sampleWorkflow = (overrides: Partial<JoyWorkflow> = {}): JoyWorkflow => ({
  formatVersion: WORKFLOW_FORMAT_VERSION,
  id: 'wf-headless',
  version: '1.0.0',
  name: 'Headless test workflow',
  inputs: {
    type: 'object',
    required: ['title'],
    properties: { title: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  },
  outputs: {
    type: 'object',
    required: ['save'],
    properties: { save: { type: 'object' } },
  },
  nodes: [
    {
      id: 'title',
      category: 'input',
      type: 'input.item',
      params: { path: 'title' },
      deterministic: true,
    },
    {
      id: 'gate',
      category: 'decision',
      type: 'decision.approval',
      params: {
        kind: 'approve-render',
        prompt: 'Approve the title?',
        payloadFrom: { kind: 'upstream', node: 'title' },
      },
      deterministic: false,
    },
    {
      id: 'save',
      category: 'output',
      type: 'output.metadata',
      params: {
        folderId: 'exports',
        fileName: 'meta.json',
        source: { kind: 'upstream', node: 'gate' },
      },
      deterministic: true,
    },
  ],
  edges: [
    { from: 'title', to: 'gate' },
    { from: 'gate', to: 'save' },
  ],
  permissions: [],
  policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
  ...overrides,
});

const libraryWithOutputPort = () => {
  const written: unknown[] = [];
  const library = buildNodeLibrary({
    ports: {
      output: {
        writeMetadataFile: (args) => {
          written.push(args);
          return { folderId: args.folderId, fileName: args.fileName, written: true };
        },
      },
    },
  });
  return { library, written };
};

describe('runWorkflowHeadless', () => {
  it('binds validated inputs, runs to a parked approval, then resumes to outputs (§7.4)', () => {
    const { library } = libraryWithOutputPort();
    const workflowJson = workflowToJson(sampleWorkflow());

    const first = runWorkflowHeadless({
      workflowJson,
      inputs: { title: 'Launch reel' },
      handlers: library.handlers,
      registry: library.registry,
      runId: 'run-headless-1',
      projectRevision: 'rev-1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.state).toBe('waiting_for_input');
    expect(first.checkpoint.nodes['gate']?.pendingRequest?.payload).toBe('Launch reel');
    expect(first.outputs).toEqual({});
    expect(first.outputIssues).toEqual([]);

    // The checkpoint JSON-round-trips: exactly what the CLI writes and reloads.
    const checkpointJson = JSON.stringify(first.checkpoint);
    const second = runWorkflowHeadless({
      workflowJson,
      inputs: { title: 'Launch reel' },
      handlers: library.handlers,
      registry: library.registry,
      runId: 'run-headless-1',
      projectRevision: 'rev-1',
      resumeFromJson: checkpointJson,
      humanInputs: { gate: { approved: true } },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.state).toBe('succeeded');
    expect(second.dashboard.reusedNodeIds).toEqual(['title']);
    expect(second.outputs).toEqual({
      save: { folderId: 'exports', fileName: 'meta.json', written: true },
    });
    expect(second.outputIssues).toEqual([]);
    expect(second.dashboard.nodes[2]?.state).toBe('succeeded');
  });

  it('rejects inputs that violate the declared schema before executing anything', () => {
    const { library, written } = libraryWithOutputPort();
    const result = runWorkflowHeadless({
      workflowJson: workflowToJson(sampleWorkflow()),
      inputs: { titel: 'typo' },
      handlers: library.handlers,
      registry: library.registry,
      runId: 'run-headless-2',
      projectRevision: 'rev-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.every((issue) => issue.code === 'headless/invalid-inputs')).toBe(true);
      const paths = result.issues.map((issue) => issue.path);
      expect(paths).toContain('$.title');
      expect(paths).toContain('$.titel');
    }
    expect(written).toEqual([]);
  });

  it('surfaces authoring issues from the workflow JSON without throwing', () => {
    const { library } = libraryWithOutputPort();
    const invalid = runWorkflowHeadless({
      workflowJson: '{ not json',
      inputs: {},
      handlers: library.handlers,
      registry: library.registry,
      runId: 'run-headless-3',
      projectRevision: 'rev-1',
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues[0]?.code).toBe('authoring/invalid-json');
    }
  });

  it('rejects malformed or mismatched checkpoints with coded issues', () => {
    const { library } = libraryWithOutputPort();
    const workflowJson = workflowToJson(sampleWorkflow());
    const base = {
      workflowJson,
      inputs: { title: 'x' },
      handlers: library.handlers,
      registry: library.registry,
      runId: 'run-headless-4',
      projectRevision: 'rev-1',
    };

    const malformed = runWorkflowHeadless({ ...base, resumeFromJson: '][' });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.issues[0]?.code).toBe('headless/invalid-checkpoint');
    }

    const first = runWorkflowHeadless(base);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const mismatched = runWorkflowHeadless({
      ...base,
      projectRevision: 'rev-2',
      resumeFromJson: JSON.stringify(first.checkpoint),
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.issues[0]?.code).toBe('workflow/checkpoint-mismatch');
    }
  });

  it('reports output-schema violations of a succeeded run as outputIssues', () => {
    const { library } = libraryWithOutputPort();
    const wf = sampleWorkflow({
      outputs: {
        type: 'object',
        required: ['save', 'missing-node'],
      },
    });
    const first = runWorkflowHeadless({
      workflowJson: workflowToJson(wf),
      inputs: { title: 'x' },
      handlers: library.handlers,
      registry: library.registry,
      runId: 'run-headless-5',
      projectRevision: 'rev-1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = runWorkflowHeadless({
      workflowJson: workflowToJson(wf),
      inputs: { title: 'x' },
      handlers: library.handlers,
      registry: library.registry,
      runId: 'run-headless-5',
      projectRevision: 'rev-1',
      resumeFromJson: JSON.stringify(first.checkpoint),
      humanInputs: { gate: true },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.state).toBe('succeeded');
    expect(second.outputIssues.map((issue) => issue.code)).toEqual(['headless/invalid-outputs']);
    expect(second.outputIssues[0]?.path).toBe('$.missing-node');
  });

  it('fails honestly with a coded port error when a required port is missing', () => {
    // No output port supplied: output.metadata must fail coded, not pretend to write.
    const library = buildNodeLibrary();
    const result = runWorkflowHeadless({
      workflowJson: workflowToJson(sampleWorkflow()),
      inputs: { title: 'x' },
      handlers: library.handlers,
      registry: library.registry,
      runId: 'run-headless-6',
      projectRevision: 'rev-1',
      humanInputs: { gate: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state).toBe('failed');
    const save = result.checkpoint.nodes['save'];
    expect(save?.state).toBe('failed');
    expect(save?.failureCode).toBe('workflow/port-unavailable:output.writeMetadataFile');
    expect(result.outputs).toEqual({});
  });
});

describe('joy-workflow CLI', () => {
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bin = join(packageDir, 'bin', 'joy-workflow.mjs');
  const built = existsSync(join(packageDir, 'dist', 'index.js'));

  it.skipIf(!built)('validates a workflow file and reports the execution order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-workflow-'));
    const workflowPath = join(dir, 'workflow.json');
    writeFileSync(workflowPath, workflowToJson(sampleWorkflow()));

    const result = spawnSync(process.execPath, [bin, 'validate', workflowPath], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { ok: boolean; order: string[] };
    expect(report.ok).toBe(true);
    expect(report.order).toEqual(['title', 'gate', 'save']);
  });

  it.skipIf(!built)('runs headlessly, writes run files, and exits 3 while parked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-workflow-run-'));
    const workflowPath = join(dir, 'workflow.json');
    const inputsPath = join(dir, 'inputs.json');
    const outDir = join(dir, 'out');
    writeFileSync(workflowPath, workflowToJson(sampleWorkflow()));
    writeFileSync(inputsPath, JSON.stringify({ title: 'CLI reel' }));

    const result = spawnSync(
      process.execPath,
      [bin, 'run', workflowPath, '--inputs', inputsPath, '--out', outDir, '--run-id', 'cli-run'],
      { encoding: 'utf8' },
    );
    // Parked at the approval gate (§23.6): exit 3, checkpoint + dashboard written.
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('waiting_for_input');
    const checkpoint = JSON.parse(readFileSync(join(outDir, 'checkpoint.json'), 'utf8')) as {
      state: string;
    };
    expect(checkpoint.state).toBe('waiting_for_input');
    expect(existsSync(join(outDir, 'dashboard.json'))).toBe(true);
    expect(existsSync(join(outDir, 'outputs.json'))).toBe(true);
  });
});
