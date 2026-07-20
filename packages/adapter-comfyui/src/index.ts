import type {
  CapabilityDeclaration,
  CapabilityId,
  CapabilityResult,
  Diagnostic,
  GeneratedOutput,
  GenerationProvenance,
  ProviderManifestV2,
  ProviderV2,
  ResourceEstimate,
} from '@joy-media/provider-sdk';

export interface WorkflowInput {
  readonly name: string;
  readonly type: 'image' | 'text' | 'number' | 'boolean' | 'audio';
  readonly required: boolean;
  readonly defaultValue?: unknown;
  readonly description: string;
}

export interface WorkflowOutput {
  readonly name: string;
  readonly type: 'image' | 'text' | 'audio' | 'video';
  readonly description: string;
}

export interface ComfyUIWorkflowTemplate {
  readonly templateId: string;
  readonly version: string;
  readonly capability: CapabilityId;
  readonly displayName: string;
  readonly description: string;
  readonly requiredCustomNodes: readonly string[];
  readonly requiredModels: readonly string[];
  readonly inputs: readonly WorkflowInput[];
  readonly outputs: readonly WorkflowOutput[];
  readonly resourceEstimate: ResourceEstimate;
  readonly rawWorkflow: unknown;
  readonly license?: string;
}

export interface ComfyUIAdapterConfig {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export const IMAGE_UPSCALE_TEMPLATE: ComfyUIWorkflowTemplate = {
  templateId: 'image-upscale-v1',
  version: '1.0.0',
  capability: 'image.upscale',
  displayName: 'Image Upscale',
  description: 'Upscale image resolution using AI',
  requiredCustomNodes: ['comfyui-upscaler'],
  requiredModels: ['RealESRGAN_x4plus.pth'],
  inputs: [
    {
      name: 'image',
      type: 'image',
      required: true,
      description: 'Input image to upscale',
    },
    {
      name: 'scale',
      type: 'number',
      required: false,
      defaultValue: 2,
      description: 'Upscale factor (2x, 4x)',
    },
  ],
  outputs: [
    {
      name: 'upscaled_image',
      type: 'image',
      description: 'Upscaled image',
    },
  ],
  resourceEstimate: {
    estimatedDurationMs: 5000,
    estimatedMemoryMb: 512,
    estimatedGpuMb: 1024,
  },
  rawWorkflow: {
    nodes: [
      { id: 1, type: 'LoadImage' },
      { id: 2, type: 'UpscaleModelLoader' },
      { id: 3, type: 'ImageUpscaleWithModel' },
      { id: 4, type: 'SaveImage' },
    ],
  },
  license: 'MIT',
};

export const BACKGROUND_REMOVAL_TEMPLATE: ComfyUIWorkflowTemplate = {
  templateId: 'background-removal-v1',
  version: '1.0.0',
  capability: 'image.removeBackground',
  displayName: 'Background Removal',
  description: 'Remove background from image',
  requiredCustomNodes: ['comfyui-rembg'],
  requiredModels: ['u2net.onnx'],
  inputs: [
    {
      name: 'image',
      type: 'image',
      required: true,
      description: 'Input image',
    },
    {
      name: 'model',
      type: 'text',
      required: false,
      defaultValue: 'u2net',
      description: 'Segmentation model',
    },
  ],
  outputs: [
    {
      name: 'foreground',
      type: 'image',
      description: 'Image with background removed',
    },
    {
      name: 'mask',
      type: 'image',
      description: 'Background mask',
    },
  ],
  resourceEstimate: {
    estimatedDurationMs: 3000,
    estimatedMemoryMb: 256,
    estimatedGpuMb: 512,
  },
  rawWorkflow: {
    nodes: [
      { id: 1, type: 'LoadImage' },
      { id: 2, type: 'RemBGSession' },
      { id: 3, type: 'RemBGRemove' },
      { id: 4, type: 'SaveImage' },
    ],
  },
  license: 'MIT',
};

let requestCounter = 0;

function generateRequestId(): string {
  requestCounter++;
  return `comfyui-${Date.now()}-${requestCounter}`;
}

function generateAssetId(templateId: string, outputName: string): string {
  return `asset-${templateId}-${outputName}-${Date.now()}`;
}

function hashRequest(input: unknown): string {
  const str = JSON.stringify(input);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `hash-${Math.abs(hash).toString(36)}`;
}

function validateInputs(
  template: ComfyUIWorkflowTemplate,
  input: Record<string, unknown>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const inputDef of template.inputs) {
    if (inputDef.required && !(inputDef.name in input)) {
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_REQUIRED_INPUT',
        message: `Required input '${inputDef.name}' is missing`,
      });
    }

    if (inputDef.name in input) {
      const value = input[inputDef.name];
      const expectedType = inputDef.type;

      if (expectedType === 'image' && !(value instanceof Uint8Array)) {
        diagnostics.push({
          severity: 'warning',
          code: 'TYPE_MISMATCH',
          message: `Input '${inputDef.name}' expected image (Uint8Array), got ${typeof value}`,
        });
      } else if (expectedType === 'text' && typeof value !== 'string') {
        diagnostics.push({
          severity: 'warning',
          code: 'TYPE_MISMATCH',
          message: `Input '${inputDef.name}' expected text, got ${typeof value}`,
        });
      } else if (expectedType === 'number' && typeof value !== 'number') {
        diagnostics.push({
          severity: 'warning',
          code: 'TYPE_MISMATCH',
          message: `Input '${inputDef.name}' expected number, got ${typeof value}`,
        });
      } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
        diagnostics.push({
          severity: 'warning',
          code: 'TYPE_MISMATCH',
          message: `Input '${inputDef.name}' expected boolean, got ${typeof value}`,
        });
      }
    }
  }

  return diagnostics;
}

function mapInputsToWorkflow(
  template: ComfyUIWorkflowTemplate,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const workflowInputs: Record<string, unknown> = {};

  for (const inputDef of template.inputs) {
    if (inputDef.name in input) {
      workflowInputs[inputDef.name] = input[inputDef.name];
    } else if (inputDef.defaultValue !== undefined) {
      workflowInputs[inputDef.name] = inputDef.defaultValue;
    }
  }

  return workflowInputs;
}

async function executeWorkflow(
  _config: ComfyUIAdapterConfig,
  _template: ComfyUIWorkflowTemplate,
  _workflowInputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await new Promise((resolve) => setTimeout(resolve, 10));

  const outputs: Record<string, unknown> = {};
  for (const outputDef of _template.outputs) {
    if (outputDef.type === 'image') {
      outputs[outputDef.name] = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    } else if (outputDef.type === 'text') {
      outputs[outputDef.name] = 'mock text output';
    } else if (outputDef.type === 'audio') {
      outputs[outputDef.name] = new Uint8Array([0, 0, 0, 0]);
    } else if (outputDef.type === 'video') {
      outputs[outputDef.name] = new Uint8Array([0, 0, 0, 0]);
    }
  }

  return outputs;
}

function mapOutputsToGenerated(
  template: ComfyUIWorkflowTemplate,
  workflowOutputs: Record<string, unknown>,
): GeneratedOutput[] {
  const outputs: GeneratedOutput[] = [];

  for (const outputDef of template.outputs) {
    const value = workflowOutputs[outputDef.name];
    if (value === undefined) continue;

    let mimeType: string;
    let kind: GeneratedOutput['kind'];

    switch (outputDef.type) {
      case 'image':
        mimeType = 'image/png';
        kind = 'image';
        break;
      case 'text':
        mimeType = 'text/plain';
        kind = 'text';
        break;
      case 'audio':
        mimeType = 'audio/wav';
        kind = 'audio';
        break;
      case 'video':
        mimeType = 'video/mp4';
        kind = 'video';
        break;
    }

    outputs.push({
      kind,
      assetId: generateAssetId(template.templateId, outputDef.name),
      mimeType,
      bytes: value instanceof Uint8Array ? value : undefined,
      metadata: {
        templateId: template.templateId,
        outputName: outputDef.name,
      },
    });
  }

  return outputs;
}

export function createComfyUIAdapter(
  config: ComfyUIAdapterConfig,
  templates: readonly ComfyUIWorkflowTemplate[],
): ProviderV2 {
  const capabilities: CapabilityDeclaration[] = [];
  const templateMap = new Map<CapabilityId, ComfyUIWorkflowTemplate>();

  for (const template of templates) {
    if (!templateMap.has(template.capability)) {
      templateMap.set(template.capability, template);
      capabilities.push({
        id: template.capability,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            template.inputs.map((input) => [
              input.name,
              {
                type: input.type === 'image' ? 'string' : input.type,
                description: input.description,
              },
            ]),
          ),
          required: template.inputs.filter((i) => i.required).map((i) => i.name),
        },
        outputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            template.outputs.map((output) => [
              output.name,
              {
                type: output.type === 'image' ? 'string' : output.type,
                description: output.description,
              },
            ]),
          ),
        },
        estimatedResources: template.resourceEstimate,
      });
    }
  }

  const manifest: ProviderManifestV2 = {
    protocolVersion: 2,
    id: 'joy.comfyui',
    displayName: 'ComfyUI Workflow Provider',
    adapterVersion: '1.0.0',
    execution: 'remote-api',
    capabilities,
    configurationSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', format: 'uri' },
        timeoutMs: { type: 'number', minimum: 1000 },
        pollIntervalMs: { type: 'number', minimum: 100 },
      },
      required: ['endpoint'],
    },
    secretFields: [],
    healthCheck: {
      endpoint: `${config.endpoint}/health`,
      intervalMs: 30000,
      timeoutMs: 5000,
    },
    privacy: {
      dataLeavesDevice: true,
      retentionDisclosure: 'Data sent to ComfyUI server for processing',
    },
  };

  return {
    manifest,
    invoke: async (capability: CapabilityId, input: unknown): Promise<CapabilityResult> => {
      const startTime = Date.now();
      const requestId = generateRequestId();

      const template = templateMap.get(capability);
      if (!template) {
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance: {
            providerId: manifest.id,
            modelId: 'unknown',
            adapterVersion: manifest.adapterVersion,
            createdAt: new Date().toISOString(),
            requestHash: hashRequest(input),
            idempotencyKey: requestId,
            processingTimeMs: Date.now() - startTime,
            execution: manifest.execution,
          },
          diagnostics: [
            {
              severity: 'error',
              code: 'UNSUPPORTED_CAPABILITY',
              message: `Capability '${capability}' not supported by this adapter`,
            },
          ],
        };
      }

      const inputObj = (input ?? {}) as Record<string, unknown>;
      const diagnostics = validateInputs(template, inputObj);

      const hasErrors = diagnostics.some((d) => d.severity === 'error');
      if (hasErrors) {
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance: {
            providerId: manifest.id,
            modelId: template.templateId,
            adapterVersion: manifest.adapterVersion,
            createdAt: new Date().toISOString(),
            requestHash: hashRequest(input),
            idempotencyKey: requestId,
            processingTimeMs: Date.now() - startTime,
            execution: manifest.execution,
          },
          diagnostics,
        };
      }

      const workflowInputs = mapInputsToWorkflow(template, inputObj);

      try {
        const workflowOutputs = await executeWorkflow(config, template, workflowInputs);
        const outputs = mapOutputsToGenerated(template, workflowOutputs);

        const provenance: GenerationProvenance = {
          providerId: manifest.id,
          modelId: template.templateId,
          adapterVersion: manifest.adapterVersion,
          createdAt: new Date().toISOString(),
          requestHash: hashRequest(input),
          idempotencyKey: requestId,
          processingTimeMs: Date.now() - startTime,
          execution: manifest.execution,
        };

        return {
          requestId,
          status: 'succeeded',
          outputs,
          provenance,
          diagnostics,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance: {
            providerId: manifest.id,
            modelId: template.templateId,
            adapterVersion: manifest.adapterVersion,
            createdAt: new Date().toISOString(),
            requestHash: hashRequest(input),
            idempotencyKey: requestId,
            processingTimeMs: Date.now() - startTime,
            execution: manifest.execution,
          },
          diagnostics: [
            ...diagnostics,
            {
              severity: 'error',
              code: 'WORKFLOW_EXECUTION_FAILED',
              message: errorMessage,
            },
          ],
        };
      }
    },
  };
}
