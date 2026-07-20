import { describe, expect, it } from 'vitest';

import {
  WorkflowAuthoringError,
  WorkflowBuilder,
  parseWorkflowJson,
  validateAgainstSchema,
  validateSchemaDeclaration,
  workflowToJson,
} from './authoring.js';
import type { JoyWorkflow } from './definition.js';
import { WORKFLOW_FORMAT_VERSION } from './definition.js';
import { buildNodeLibrary } from './library.js';

const sampleWorkflow = (overrides: Partial<JoyWorkflow> = {}): JoyWorkflow => ({
  formatVersion: WORKFLOW_FORMAT_VERSION,
  id: 'wf-authoring',
  version: '1.0.0',
  name: 'Authoring test workflow',
  inputs: { type: 'object', required: ['source'], properties: { source: { type: 'string' } } },
  outputs: { type: 'object' },
  nodes: [
    {
      id: 'load',
      category: 'input',
      type: 'input.value',
      params: { value: { kind: 'input', path: 'source' } },
      deterministic: true,
    },
    {
      id: 'save',
      category: 'output',
      type: 'output.metadata',
      params: { folderId: 'exports', fileName: 'meta.json' },
      deterministic: true,
    },
  ],
  edges: [{ from: 'load', to: 'save' }],
  permissions: [],
  policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
  ...overrides,
});

describe('validateSchemaDeclaration', () => {
  it('accepts a declaration in the supported subset, including nesting', () => {
    const issues = validateSchemaDeclaration({
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      additionalProperties: false,
    });
    expect(issues).toEqual([]);
  });

  it('rejects non-object declarations, unsupported keywords, and bad types with paths', () => {
    expect(validateSchemaDeclaration('nope')[0]?.message).toContain('must be an object');
    const issues = validateSchemaDeclaration({
      type: 'object',
      patternProperties: {},
      properties: { a: { type: 'tuple' } },
    });
    expect(issues.some((i) => i.message.includes('unsupported schema keyword'))).toBe(true);
    expect(issues.some((i) => i.path === '$.properties.a')).toBe(true);
  });
});

describe('validateAgainstSchema', () => {
  const schema = {
    type: 'object',
    required: ['name', 'count'],
    properties: {
      name: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 0, maximum: 10 },
      mode: { enum: ['draft', 'final'] },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    additionalProperties: false,
  };

  it('accepts a conforming value', () => {
    const issues = validateAgainstSchema(schema, {
      name: 'reel',
      count: 3,
      mode: 'draft',
      tags: ['a'],
    });
    expect(issues).toEqual([]);
  });

  it('reports missing required, wrong types, bounds, enum, and extras with paths', () => {
    const issues = validateAgainstSchema(schema, {
      count: 3.5,
      mode: 'other',
      tags: [],
      extra: 1,
    });
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('$.name'); // required missing
    expect(paths).toContain('$.count'); // integer violated
    expect(paths).toContain('$.mode'); // enum violated
    expect(paths).toContain('$.tags'); // minItems violated
    expect(paths).toContain('$.extra'); // additionalProperties: false
  });

  it('validates array items and integer acceptance for whole numbers', () => {
    expect(validateAgainstSchema({ type: 'integer' }, 4)).toEqual([]);
    const issues = validateAgainstSchema({ type: 'array', items: { type: 'number' } }, [1, 'x']);
    expect(issues[0]?.path).toBe('$[1]');
  });
});

describe('parseWorkflowJson', () => {
  it('parses and validates a well-formed workflow, returning the execution order', () => {
    const result = parseWorkflowJson(workflowToJson(sampleWorkflow()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order).toEqual(['load', 'save']);
      expect(result.workflow.id).toBe('wf-authoring');
    }
  });

  it('reports malformed JSON with a coded issue and never throws', () => {
    const result = parseWorkflowJson('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe('authoring/invalid-json');
    }
  });

  it('reports structural shape issues with JSON paths before typed validation', () => {
    const result = parseWorkflowJson(
      JSON.stringify({
        formatVersion: '1',
        id: 'wf',
        version: '1.0.0',
        name: 'bad shapes',
        inputs: {},
        outputs: {},
        nodes: [{ id: 'a', category: 'input', type: 'input.value' }],
        edges: [{ from: 'a' }],
        permissions: [{}],
        policy: { concurrency: 1, failure: 'stop' },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.every((issue) => issue.code === 'authoring/invalid-shape')).toBe(true);
      const paths = result.issues.map((issue) => issue.path);
      expect(paths).toContain('$.formatVersion');
      expect(paths).toContain('$.nodes[0].params');
      expect(paths).toContain('$.nodes[0].deterministic');
      expect(paths).toContain('$.edges[0]');
      expect(paths).toContain('$.permissions[0]');
      expect(paths).toContain('$.policy.defaultRetry');
    }
  });

  it('passes through workflow/* definition issues (cycles, bad policy)', () => {
    const wf = sampleWorkflow({
      edges: [
        { from: 'load', to: 'save' },
        { from: 'save', to: 'load' },
      ],
    });
    const result = parseWorkflowJson(workflowToJson(wf));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'workflow/cycle')).toBe(true);
    }
  });

  it('rejects out-of-subset inputs/outputs schema declarations', () => {
    const wf = sampleWorkflow({ inputs: { type: 'object', oneOf: [] } });
    const result = parseWorkflowJson(workflowToJson(wf));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.code === 'authoring/invalid-schema');
      expect(issue?.path).toBe('$.inputs');
    }
  });

  it('applies registry node validation when a registry is supplied', () => {
    const { registry } = buildNodeLibrary();
    const good = parseWorkflowJson(workflowToJson(sampleWorkflow()), { registry });
    expect(good.ok).toBe(true);

    const wf = sampleWorkflow({
      nodes: [
        {
          id: 'load',
          category: 'input',
          type: 'input.does-not-exist',
          params: {},
          deterministic: true,
        },
      ],
      edges: [],
    });
    const bad = parseWorkflowJson(workflowToJson(wf), { registry });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues[0]?.code).toBe('node-library/unknown-type');
      expect(bad.issues[0]?.nodeId).toBe('load');
    }
  });

  it('round-trips through workflowToJson without loss', () => {
    const wf = sampleWorkflow();
    const result = parseWorkflowJson(workflowToJson(wf));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workflow).toEqual(wf);
      expect(workflowToJson(result.workflow)).toBe(workflowToJson(wf));
    }
  });
});

describe('WorkflowBuilder', () => {
  it('builds a validated workflow from registry-created nodes', () => {
    const { registry } = buildNodeLibrary();
    const { workflow, order } = new WorkflowBuilder(registry, {
      id: 'wf-built',
      version: '1.0.0',
      name: 'Built workflow',
      inputs: { type: 'object' },
    })
      .node('text', 'input.value', { value: { kind: 'literal', value: 'hello' } })
      .node('save', 'output.metadata', { folderId: 'exports', fileName: 'meta.json' })
      .edge('text', 'save')
      .permission('local.write')
      .build();
    expect(order).toEqual(['text', 'save']);
    expect(workflow.nodes[0]?.category).toBe('input');
    expect(workflow.permissions).toEqual([{ capability: 'local.write' }]);
    expect(workflow.policy).toEqual({
      concurrency: 1,
      failure: 'stop',
      defaultRetry: { maxAttempts: 1, backoffMs: 0 },
    });
  });

  it('rejects invalid params at authoring time via the registry', () => {
    const { registry } = buildNodeLibrary();
    const builder = new WorkflowBuilder(registry, {
      id: 'wf-bad',
      version: '1.0.0',
      name: 'Bad params',
    });
    expect(() => builder.node('save', 'output.metadata', {})).toThrowError(/invalid params/);
  });

  it('rejects duplicate node ids immediately and bad graphs at build()', () => {
    const { registry } = buildNodeLibrary();
    const builder = new WorkflowBuilder(registry, {
      id: 'wf-dup',
      version: '1.0.0',
      name: 'Duplicate ids',
    }).node('text', 'input.value', { value: { kind: 'literal', value: 'x' } });
    expect(() =>
      builder.node('text', 'input.value', { value: { kind: 'literal', value: 'y' } }),
    ).toThrowError(WorkflowAuthoringError);

    const dangling = new WorkflowBuilder(registry, {
      id: 'wf-dangling',
      version: '1.0.0',
      name: 'Dangling edge',
    })
      .node('text', 'input.value', { value: { kind: 'literal', value: 'x' } })
      .edge('text', 'missing');
    try {
      dangling.build();
      expect.unreachable('build() must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowAuthoringError);
      const authoringError = error as WorkflowAuthoringError;
      expect(authoringError.code).toBe('authoring/invalid-workflow');
      expect(
        authoringError.issues.some((issue) => issue.code === 'workflow/unknown-edge-endpoint'),
      ).toBe(true);
    }
  });
});
