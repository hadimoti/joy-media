import type {
  CapabilityDeclaration,
  CapabilityId,
  CapabilityRequest,
  CapabilityResult,
  Diagnostic,
  GeneratedOutput,
  GenerationProvenance,
  ProviderManifestV2,
  ProviderV2,
} from '@joy-media/provider-sdk';

export interface VoiceIsolationConfig {
  readonly execution: 'worker-local' | 'remote-api';
  readonly modelPath?: string;
  readonly mode: 'isolate-voice' | 'remove-voice' | 'separate-stems';
}

export interface VoiceIsolationInput {
  readonly assetId: string;
  readonly data?: Uint8Array;
  readonly sampleRate?: number;
  readonly decisionId?: string;
}

let requestCounter = 0;

function generateRequestId(): string {
  requestCounter++;
  return `voice-isolation-${Date.now()}-${requestCounter}`;
}

function generateAssetId(inputAssetId: string, stem: string): string {
  return `${inputAssetId}-${stem}-${Date.now()}`;
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

function processVoiceIsolation(
  config: VoiceIsolationConfig,
  input: VoiceIsolationInput,
): GeneratedOutput[] {
  const inputData = input.data ?? new Uint8Array(1024);
  const outputs: GeneratedOutput[] = [];

  switch (config.mode) {
    case 'isolate-voice': {
      outputs.push({
        kind: 'audio',
        assetId: generateAssetId(input.assetId, 'voice'),
        mimeType: 'audio/wav',
        bytes: new Uint8Array(inputData),
        metadata: {
          stem: 'voice',
          sourceAssetId: input.assetId,
          mode: config.mode,
        },
      });
      break;
    }
    case 'remove-voice': {
      outputs.push({
        kind: 'audio',
        assetId: generateAssetId(input.assetId, 'no-voice'),
        mimeType: 'audio/wav',
        bytes: new Uint8Array(inputData),
        metadata: {
          stem: 'no-voice',
          sourceAssetId: input.assetId,
          mode: config.mode,
        },
      });
      break;
    }
    case 'separate-stems': {
      outputs.push(
        {
          kind: 'audio',
          assetId: generateAssetId(input.assetId, 'vocals'),
          mimeType: 'audio/wav',
          bytes: new Uint8Array(inputData),
          metadata: {
            stem: 'vocals',
            sourceAssetId: input.assetId,
            mode: config.mode,
          },
        },
        {
          kind: 'audio',
          assetId: generateAssetId(input.assetId, 'drums'),
          mimeType: 'audio/wav',
          bytes: new Uint8Array(inputData),
          metadata: {
            stem: 'drums',
            sourceAssetId: input.assetId,
            mode: config.mode,
          },
        },
        {
          kind: 'audio',
          assetId: generateAssetId(input.assetId, 'bass'),
          mimeType: 'audio/wav',
          bytes: new Uint8Array(inputData),
          metadata: {
            stem: 'bass',
            sourceAssetId: input.assetId,
            mode: config.mode,
          },
        },
        {
          kind: 'audio',
          assetId: generateAssetId(input.assetId, 'other'),
          mimeType: 'audio/wav',
          bytes: new Uint8Array(inputData),
          metadata: {
            stem: 'other',
            sourceAssetId: input.assetId,
            mode: config.mode,
          },
        },
      );
      break;
    }
  }

  return outputs;
}

function callerDecisionId(input: unknown): string | undefined {
  return input !== null &&
    typeof input === 'object' &&
    typeof (input as { decisionId?: unknown }).decisionId === 'string'
    ? (input as { decisionId: string }).decisionId
    : undefined;
}

function buildProvenance(
  manifest: ProviderManifestV2,
  modelId: string,
  input: unknown,
  startTime: number,
  requestId: string,
  request?: CapabilityRequest,
): GenerationProvenance {
  const idempotencyKey = request?.idempotencyKey ?? requestId;
  const providerDecisionId = callerDecisionId(input);
  return {
    providerId: manifest.id,
    modelId,
    adapterVersion: manifest.adapterVersion,
    createdAt: new Date().toISOString(),
    requestHash: hashRequest({ input, idempotencyKey, providerDecisionId }),
    idempotencyKey,
    processingTimeMs: Date.now() - startTime,
    execution: manifest.execution,
    ...(providerDecisionId === undefined ? {} : { providerDecisionId }),
  };
}

function unavailableDiagnostic(): Diagnostic {
  return {
    severity: 'error',
    code: 'PROVIDER_UNAVAILABLE',
    message:
      'VOICE_ISOLATION_UNAVAILABLE: production voice isolation is not wired; use createFixtureVoiceIsolationAdapter only in explicit tests.',
  };
}

function createVoiceIsolationAdapterInternal(
  config: VoiceIsolationConfig,
  fixtureMode: boolean,
): ProviderV2 {
  const isLocal = config.execution === 'worker-local';
  const modelId = config.modelPath ?? 'default';

  const capability: CapabilityDeclaration = {
    id: 'audio.separate',
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
        stems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              assetId: { type: 'string' },
              mimeType: { type: 'string' },
              stem: { type: 'string' },
            },
          },
        },
      },
    },
    ...(config.modelPath === undefined
      ? {}
      : { models: [{ id: config.modelPath, displayName: 'Voice Isolation Model' }] }),
    estimatedResources: {
      estimatedDurationMs: 5000,
      estimatedMemoryMb: isLocal ? 512 : 0,
      estimatedGpuMb: isLocal ? 256 : 0,
    },
  };

  const manifest: ProviderManifestV2 = {
    protocolVersion: 2,
    id: 'joy.voice-isolation',
    displayName: 'Voice Isolation Adapter',
    adapterVersion: '1.0.0',
    execution: config.execution,
    capabilities: [capability],
    configurationSchema: {
      type: 'object',
      properties: {
        execution: { type: 'string', enum: ['worker-local', 'remote-api'] },
        modelPath: { type: 'string' },
        mode: {
          type: 'string',
          enum: ['isolate-voice', 'remove-voice', 'separate-stems'],
        },
      },
      required: ['execution', 'mode'],
    },
    secretFields: [],
    privacy: {
      dataLeavesDevice: !isLocal,
      ...(isLocal ? {} : { retentionDisclosure: 'Audio sent to remote API for processing' }),
    },
  };

  return {
    manifest,
    invoke: async (
      capabilityId: CapabilityId,
      input: unknown,
      request?: CapabilityRequest,
    ): Promise<CapabilityResult> => {
      const startTime = Date.now();
      const requestId = generateRequestId();
      const provenance = buildProvenance(manifest, modelId, input, startTime, requestId, request);

      if (capabilityId !== 'audio.separate') {
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance,
          diagnostics: [
            {
              severity: 'error',
              code: 'UNSUPPORTED_CAPABILITY',
              message: `Capability '${capabilityId}' not supported. This adapter only supports 'audio.separate'.`,
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
          provenance,
          diagnostics: validation.diagnostics,
        };
      }

      const voiceInput = input as VoiceIsolationInput;
      if (!fixtureMode) {
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance,
          diagnostics: [...validation.diagnostics, unavailableDiagnostic()],
        };
      }

      try {
        const outputs = processVoiceIsolation(config, voiceInput);

        return {
          requestId,
          status: 'succeeded',
          outputs,
          provenance,
          diagnostics: validation.diagnostics,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          requestId,
          status: 'failed',
          outputs: [],
          provenance,
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

export function createVoiceIsolationAdapter(config: VoiceIsolationConfig): ProviderV2 {
  return createVoiceIsolationAdapterInternal(config, false);
}

export function createFixtureVoiceIsolationAdapter(config: VoiceIsolationConfig): ProviderV2 {
  return createVoiceIsolationAdapterInternal(config, true);
}
