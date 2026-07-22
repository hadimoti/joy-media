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
} from './types.js';
import { ProviderUnavailableError } from './errors.js';

let testCounter = 0;

export function createMockProvider(
  id: string,
  capabilities: readonly CapabilityId[],
  options?: {
    execution?: ProviderManifestV2['execution'];
    privacy?: ProviderManifestV2['privacy'];
  },
): ProviderV2 {
  const caps: CapabilityDeclaration[] = capabilities.map((cap) => ({
    id: cap,
    inputSchema: {},
    outputSchema: {},
  }));

  const manifest: ProviderManifestV2 = {
    protocolVersion: 2,
    id,
    displayName: `Mock Provider ${id}`,
    adapterVersion: '1.0.0',
    execution: options?.execution ?? 'worker-local',
    capabilities: caps,
    configurationSchema: {},
    secretFields: [],
    privacy: options?.privacy ?? { dataLeavesDevice: false },
  };

  return {
    manifest,
    invoke: async (
      _capability: CapabilityId,
      _input: unknown,
      request?: CapabilityRequest,
    ): Promise<CapabilityResult> => ({
      requestId: `mock-${id}-${testCounter++}`,
      status: 'succeeded',
      outputs: [],
      provenance: {
        providerId: id,
        modelId: 'mock-model',
        adapterVersion: '1.0.0',
        createdAt: new Date().toISOString(),
        requestHash: 'mock-hash',
        idempotencyKey: request?.idempotencyKey ?? `mock-key-${testCounter}`,
        processingTimeMs: 0,
        execution: options?.execution ?? 'worker-local',
      },
      diagnostics: [],
    }),
  };
}

export function validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof manifest !== 'object' || manifest === null) {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  const m = manifest as Record<string, unknown>;

  if (m.protocolVersion !== 2) {
    errors.push('protocolVersion must be 2');
  }

  if (typeof m.id !== 'string' || m.id.length === 0) {
    errors.push('id must be a non-empty string');
  }

  if (typeof m.displayName !== 'string' || (m.displayName as string).length === 0) {
    errors.push('displayName must be a non-empty string');
  }

  if (typeof m.adapterVersion !== 'string' || (m.adapterVersion as string).length === 0) {
    errors.push('adapterVersion must be a non-empty string');
  }

  const validExecutions = ['worker-local', 'remote-api', 'server', 'browser'];
  if (!validExecutions.includes(m.execution as string)) {
    errors.push(`execution must be one of: ${validExecutions.join(', ')}`);
  }

  if (!Array.isArray(m.capabilities)) {
    errors.push('capabilities must be an array');
  } else {
    for (let i = 0; i < m.capabilities.length; i++) {
      const cap = m.capabilities[i] as Record<string, unknown>;
      if (typeof cap !== 'object' || cap === null) {
        errors.push(`capabilities[${i}] must be an object`);
        continue;
      }
      if (typeof cap.id !== 'string') {
        errors.push(`capabilities[${i}].id must be a string`);
      }
      if (typeof cap.inputSchema !== 'object' || cap.inputSchema === null) {
        errors.push(`capabilities[${i}].inputSchema must be an object`);
      }
      if (typeof cap.outputSchema !== 'object' || cap.outputSchema === null) {
        errors.push(`capabilities[${i}].outputSchema must be an object`);
      }
    }
  }

  if (typeof m.configurationSchema !== 'object' || m.configurationSchema === null) {
    errors.push('configurationSchema must be an object');
  }

  if (!Array.isArray(m.secretFields)) {
    errors.push('secretFields must be an array');
  }

  if (typeof m.privacy !== 'object' || m.privacy === null) {
    errors.push('privacy must be an object');
  } else {
    const privacy = m.privacy as Record<string, unknown>;
    if (typeof privacy.dataLeavesDevice !== 'boolean' && privacy.dataLeavesDevice !== 'depends') {
      errors.push('privacy.dataLeavesDevice must be boolean or "depends"');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function createTestRequest(capability: CapabilityId, input: unknown): CapabilityRequest {
  testCounter++;
  return {
    requestVersion: 1,
    capability,
    input,
    constraints: {},
    idempotencyKey: `test-key-${testCounter}`,
  };
}

export function assertResultSucceeded(result: CapabilityResult): void {
  if (result.status !== 'succeeded') {
    throw new Error(`Expected result status 'succeeded', got '${result.status}'`);
  }
}

export function simulateProviderFailure(
  provider: ProviderV2,
  errorType: 'unavailable' | 'timeout' | 'invalid-output',
): ProviderV2 {
  return {
    manifest: provider.manifest,
    invoke: async (
      _capability: CapabilityId,
      _input: unknown,
      request?: CapabilityRequest,
    ): Promise<CapabilityResult> => {
      switch (errorType) {
        case 'unavailable':
          throw new ProviderUnavailableError('Simulated provider unavailable');
        case 'timeout':
          throw new Error('Simulated timeout');
        case 'invalid-output': {
          const provenance: GenerationProvenance = {
            providerId: provider.manifest.id,
            modelId: 'mock-model',
            adapterVersion: '1.0.0',
            createdAt: new Date().toISOString(),
            requestHash: 'mock-hash',
            idempotencyKey: request?.idempotencyKey ?? `mock-key-${testCounter++}`,
            processingTimeMs: 0,
            execution: provider.manifest.execution,
          };
          const outputs: readonly GeneratedOutput[] = [];
          const diagnostics: readonly Diagnostic[] = [
            {
              severity: 'error',
              code: 'INVALID_OUTPUT',
              message: 'Simulated invalid output',
            },
          ];
          return {
            requestId: `mock-${provider.manifest.id}-${testCounter++}`,
            status: 'failed',
            outputs,
            provenance,
            diagnostics,
          };
        }
      }
    },
  };
}
