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
    const input = params.arguments;
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: 'tool arguments must be an object' },
      };
    if (
      name.startsWith('scene3d.') &&
      ['scene3d.summary', 'scene3d.assets', 'scene3d.scene', 'scene3d.selection'].includes(name)
    )
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'json', json: this.gateway.read(name as Scene3DReadTool) }] },
      };
    if (!name.startsWith('scene3d.'))
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: 'tool is outside the scene3d allow-list' },
      };
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
