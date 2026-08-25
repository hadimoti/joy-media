import {
  dryRunScene3DTool,
  inspectScene3DTool,
  type Scene3DReadTool,
  type Scene3DApprovalBinding,
  type Scene3DToolSession,
  type Scene3DWriteTool,
} from '@joy-media/scene3d-core';
import type {
  Scene3DCommit,
  Scene3DExecutionResult,
  Scene3DPlanExecutor,
} from './scene3d-execution.js';
import type { ToolDefinition } from './types.js';
import type { ToolRegistry } from './registry.js';

export interface Scene3DMcpRequest {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface Scene3DMcpResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface Scene3DGatewayBinding {
  readonly getSession: () => Scene3DToolSession;
  readonly commit: Scene3DCommit;
}

/** In-process MCP-shaped gateway; transports remain host-owned and never gain filesystem authority. */
export class Scene3DMcpGateway {
  private readonly registry: ToolRegistry;
  private readonly executor: Scene3DPlanExecutor;
  private readonly binding: Scene3DGatewayBinding;

  constructor(options: {
    readonly registry: ToolRegistry;
    readonly executor: Scene3DPlanExecutor;
    readonly binding: Scene3DGatewayBinding;
  }) {
    this.registry = options.registry;
    this.executor = options.executor;
    this.binding = options.binding;
  }

  listTools(): readonly ToolDefinition[] {
    return this.registry.scene3dDefinitions;
  }

  read(name: Scene3DReadTool): unknown {
    return inspectScene3DTool(this.binding.getSession(), name);
  }

  preview(name: Scene3DWriteTool, input: Readonly<Record<string, unknown>>) {
    return dryRunScene3DTool(this.binding.getSession(), name, input);
  }

  callApproved(options: {
    readonly planId: string;
    readonly stepId: string;
    readonly idempotencyKey: string;
    readonly name: Scene3DWriteTool;
    readonly input: Readonly<Record<string, unknown>>;
    readonly approval: Scene3DApprovalBinding;
  }): Scene3DExecutionResult {
    const session = this.binding.getSession();
    return this.registry.executeScene3DTool(options.name, this.executor, {
      ...options,
      session,
      commit: this.binding.commit,
    });
  }
}

/** Minimal MCP JSON-RPC handler. A host owns stdin/session authentication and supplies the gateway. */
export class Scene3DMcpServer {
  private readonly gateway: Scene3DMcpGateway;

  constructor(gateway: Scene3DMcpGateway) {
    this.gateway = gateway;
  }

  handle(request: Scene3DMcpRequest): Scene3DMcpResponse {
    if (request.method === 'initialize')
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'joy-scene3d', version: '1' },
        },
      };
    if (request.method === 'notifications/initialized')
      return { jsonrpc: '2.0', id: request.id, result: null };
    if (request.method === 'tools/list')
      return { jsonrpc: '2.0', id: request.id, result: { tools: this.gateway.listTools() } };
    if (request.method !== 'tools/call')
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'method not found' },
      };
    const params = request.params ?? {};
    const name = params.name;
    if (typeof name !== 'string')
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: 'tool name is required' },
      };
    const definition = this.gateway.listTools().find((tool) => tool.name === name);
    if (definition === undefined)
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: 'tool is outside the scene3d allow-list' },
      };
    const input = params.arguments;
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: 'tool arguments must be an object' },
      };
    const schemaError = validateMcpInput(
      definition.inputSchema,
      input as Readonly<Record<string, unknown>>,
    );
    if (schemaError !== undefined)
      return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: schemaError } };
    if (definition.category === 'query')
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'json', json: this.gateway.read(name as Scene3DReadTool) }] },
      };
    for (const field of ['planId', 'stepId', 'idempotencyKey']) {
      if (typeof params[field] !== 'string' || params[field].length === 0)
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32602, message: `${field} is required for scene3d writes` },
        };
    }
    const approval = params.approval;
    if (approval === null || typeof approval !== 'object' || Array.isArray(approval))
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: 'approved scene writes require an approval binding' },
      };
    const result = this.gateway.callApproved({
      planId: typeof params.planId === 'string' ? params.planId : '',
      stepId: typeof params.stepId === 'string' ? params.stepId : '',
      idempotencyKey: typeof params.idempotencyKey === 'string' ? params.idempotencyKey : '',
      name: name as Scene3DWriteTool,
      input: input as Readonly<Record<string, unknown>>,
      approval: approval as Scene3DApprovalBinding,
    });
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'json', json: result }] },
    };
  }
}

function validateMcpInput(
  schema: Readonly<Record<string, unknown>>,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const field of required) {
      if (typeof field === 'string' && !(field in input)) return `missing required input: ${field}`;
    }
  }
  if (schema.additionalProperties === false) {
    const properties = schema.properties;
    const allowed =
      properties !== null && typeof properties === 'object' && !Array.isArray(properties)
        ? new Set(Object.keys(properties as Record<string, unknown>))
        : new Set<string>();
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown !== undefined) return `unknown input property: ${unknown}`;
  }
  const properties = schema.properties;
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, value] of Object.entries(input)) {
      const propertySchema = (properties as Record<string, unknown>)[key];
      if (
        propertySchema === null ||
        typeof propertySchema !== 'object' ||
        Array.isArray(propertySchema)
      )
        continue;
      const expectedType = (propertySchema as Record<string, unknown>).type;
      if (expectedType === 'string' && typeof value !== 'string') return `${key} must be a string`;
      if (
        expectedType === 'object' &&
        (value === null || typeof value !== 'object' || Array.isArray(value))
      )
        return `${key} must be an object`;
      const minLength = (propertySchema as Record<string, unknown>).minLength;
      if (typeof minLength === 'number' && typeof value === 'string' && value.length < minLength)
        return `${key} must be a non-empty string`;
    }
  }
  return undefined;
}
