import type {
  CapabilityDeclaration,
  CapabilityId,
  CapabilityResult,
  Diagnostic,
  GeneratedOutput,
  GenerationProvenance,
  ProviderManifestV2,
  ProviderV2,
} from '@joy-media/provider-sdk';

export interface NoiseRemovalConfig {
  readonly execution: 'worker-local' | 'remote-api';
  readonly modelPath?: string;
  readonly strength: number;
  readonly preserveFrequencies?: {
    readonly min: number;
    readonly max: number;
  };
}

export interface NoiseRemovalInput {
  readonly assetId: string;
  readonly data?: Uint8Array;
  readonly sampleRate?: number;
}

let requestCounter = 0;

function generateRequestId(): string {
  requestCounter++;
  return `noise-removal-${Date.now()}-${requestCounter}`;
}

function generateAssetId(inputAssetId: string): string {
  return `${inputAssetId}-denoised-${Date.now()}`;
}

function hashRequest(input: unknown): string {
  const str = JSON.stringify(input, (_key, value) =>
    value instanceof Uint8Array ? `<Uint8Array:${value.length}>` : value,
  );
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `hash-${Math.abs(hash).toString(36)}`;
}

function validateInput(input: unknown): { valid: boolean; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];

  if (typeof input !== 'object' || input === null) {
    diagnostics.push({
      severity: 'error',
      code: 'INVALID_INPUT',
      message: 'Input must be an object',
    });
    return { valid: false, diagnostics };
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.assetId !== 'string' || obj.assetId.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_ASSET_ID',
      message: 'Input must include a non-empty assetId string',
    });
  }

  if (obj.data !== undefined && !(obj.data instanceof Uint8Array)) {
    diagnostics.push({
      severity: 'error',
      code: 'INVALID_DATA',
      message: 'Input data must be a Uint8Array if provided',
    });
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

function processNoiseRemoval(_config: NoiseRemovalConfig, input: NoiseRemovalInput): Uint8Array {
  const inputData = input.data ?? new Uint8Array(1024);
  const output = new Uint8Array(inputData.length);

  for (let i = 0; i < inputData.length; i++) {
    output[i] = inputData[i]!;
  }

  return output;
}

export function createNoiseRemovalAdapter(config: NoiseRemovalConfig): ProviderV2 {
  if (config.strength < 0 || config.strength > 1) {
    throw new RangeError('strength must be between 0 and 1');
  }

  if (
    config.preserveFrequencies &&
    config.preserveFrequencies.min >= config.preserveFrequencies.max
  ) {
    throw new RangeError('preserveFrequencies.min must be less than max');
  }

  const isLocal = config.execution === 'worker-local';

  const capability: CapabilityDeclaration = {
    id: 'audio.denoise',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Input audio asset ID' },
        data: { type: 'string', format: 'binary', description: 'Audio data bytes' },
        sampleRate: { type: 'number', description: 'Sample rate in Hz' },
      },
      required: ['assetId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        denoised: {
          type: 'object',
          properties: {
            assetId: { type: 'string' },
            mimeType: { type: 'string' },
          },
        },
      },
    },
    models: config.modelPath
      ? [{ id: config.modelPath, displayName: 'Noise Removal Model' }]
      : undefined,
    estimatedResources: {
      estimatedDurationMs: 2000,
      estimatedMemoryMb: isLocal ? 256 : 0,
      estimatedGpuMb: isLocal ? 128 : 0,
    },
  };

  const manifest: ProviderManifestV2 = {
    protocolVersion: 2,
    id: 'joy.noise-removal',
    displayName: 'Noise Removal Adapter',
    adapterVersion: '1.0.0',
    execution: config.execution,
    capabilities: [capability],
    configurationSchema: {
      type: 'object',
      properties: {
        execution: { type: 'string', enum: ['worker-local', 'remote-api'] },
        modelPath: { type: 'string' },
        strength: { type: 'number', minimum: 0, maximum: 1 },
        preserveFrequencies: {
          type: 'object',
          properties: {
            min: { type: 'number' },
            max: { type: 'number' },
          },
        },
      },
      required: ['execution', 'strength'],
    },
    secretFields: [],
    privacy: {
      dataLeavesDevice: !isLocal,
      retentionDisclosure: isLocal ? undefined : 'Audio sent to remote API for processing',
    },
  };

  return {
    manifest,
    invoke: async (capabilityId: CapabilityId, input: unknown): Promise<CapabilityResult> => {
      const startTime = Date.now();
      const requestId = generateRequestId();

      if (capabilityId !== 'audio.denoise') {
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance: {
            providerId: manifest.id,
            modelId: config.modelPath ?? 'default',
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
              message: `Capability '${capabilityId}' not supported. This adapter only supports 'audio.denoise'.`,
            },
          ],
        };
      }

      const validation = validateInput(input);
      if (!validation.valid) {
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance: {
            providerId: manifest.id,
            modelId: config.modelPath ?? 'default',
            adapterVersion: manifest.adapterVersion,
            createdAt: new Date().toISOString(),
            requestHash: hashRequest(input),
            idempotencyKey: requestId,
            processingTimeMs: Date.now() - startTime,
            execution: manifest.execution,
          },
          diagnostics: validation.diagnostics,
        };
      }

      const noiseInput = input as NoiseRemovalInput;

      try {
        const processedData = processNoiseRemoval(config, noiseInput);
        const outputAssetId = generateAssetId(noiseInput.assetId);

        const output: GeneratedOutput = {
          kind: 'audio',
          assetId: outputAssetId,
          mimeType: 'audio/wav',
          bytes: processedData,
          metadata: {
            sourceAssetId: noiseInput.assetId,
            strength: config.strength,
            execution: config.execution,
            sampleRate: noiseInput.sampleRate ?? 48000,
          },
        };

        const provenance: GenerationProvenance = {
          providerId: manifest.id,
          modelId: config.modelPath ?? 'default',
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
          outputs: [output],
          provenance,
          diagnostics: validation.diagnostics,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance: {
            providerId: manifest.id,
            modelId: config.modelPath ?? 'default',
            adapterVersion: manifest.adapterVersion,
            createdAt: new Date().toISOString(),
            requestHash: hashRequest(input),
            idempotencyKey: requestId,
            processingTimeMs: Date.now() - startTime,
            execution: manifest.execution,
          },
          diagnostics: [
            ...validation.diagnostics,
            {
              severity: 'error',
              code: 'PROCESSING_FAILED',
              message: errorMessage,
            },
          ],
        };
      }
    },
  };
}
