// ===== V1 Types (backward compatibility) =====

export interface ProviderManifest {
  readonly id: string;
  readonly version: 1;
  readonly capabilities: readonly ['speech.transcribe'];
}

export interface TranscriptionWord {
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly confidence?: number;
  readonly speakerId?: string;
}

export interface TranscriptionResult {
  readonly language: string;
  readonly words: readonly TranscriptionWord[];
  readonly speakers?: readonly { readonly id: string; readonly name: string }[];
  readonly provenance: {
    readonly providerId: string;
    readonly modelId: string;
    readonly createdAt: string;
  };
}

export interface Provider {
  readonly manifest: ProviderManifest;
  invoke(
    capability: 'speech.transcribe',
    input: { readonly assetId: string; readonly language?: string },
  ): Promise<TranscriptionResult>;
}

// ===== V2 Types =====

export type JsonSchema = Record<string, unknown>;

export type CapabilityId =
  | 'speech.transcribe'
  | 'speech.align'
  | 'speech.diarize'
  | 'speech.synthesize'
  | 'voice.clone'
  | 'audio.denoise'
  | 'audio.separate'
  | 'music.generate'
  | 'image.generate'
  | 'image.edit'
  | 'image.removeBackground'
  | 'image.upscale'
  | 'video.generate'
  | 'video.animate'
  | 'video.interpolate'
  | 'video.removeBackground'
  | 'llm.complete'
  | 'embedding.create'
  | 'vision.analyze';

export interface ModelDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
}

export interface ResourceEstimate {
  readonly estimatedDurationMs?: number;
  readonly estimatedMemoryMb?: number;
  readonly estimatedGpuMb?: number;
}

export interface PricingDescriptor {
  readonly model: 'per-request' | 'per-second' | 'per-token' | 'per-character';
  readonly rate: string;
  readonly currency: string;
}

export interface ProviderHealthSpec {
  readonly endpoint?: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export interface Money {
  readonly amount: string;
  readonly currency: string;
}

export interface CapabilityDeclaration {
  readonly id: CapabilityId;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly models?: readonly ModelDescriptor[];
  readonly supportsStreaming?: boolean;
  readonly supportsCancel?: boolean;
  readonly supportsSeed?: boolean;
  readonly estimatedResources?: ResourceEstimate;
  readonly pricing?: PricingDescriptor;
  readonly policyFlags?: readonly string[];
}

export interface ProviderManifestV2 {
  readonly protocolVersion: 2;
  readonly id: string;
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly execution: 'worker-local' | 'remote-api' | 'server' | 'browser';
  readonly capabilities: readonly CapabilityDeclaration[];
  readonly configurationSchema: JsonSchema;
  readonly secretFields: readonly string[];
  readonly healthCheck?: ProviderHealthSpec;
  readonly privacy: {
    readonly dataLeavesDevice: boolean | 'depends';
    readonly retentionDisclosure?: string;
  };
}

export interface ProviderV2 {
  readonly manifest: ProviderManifestV2;
  invoke(capability: CapabilityId, input: unknown): Promise<CapabilityResult>;
}

export type AnyProvider = Provider | ProviderV2;

// ===== Request Types =====

export interface CapabilityRequest<TInput = unknown> {
  readonly requestVersion: 1;
  readonly capability: CapabilityId;
  readonly input: TInput;
  readonly constraints: {
    readonly executionPreference?: readonly ('local' | 'remote')[];
    readonly maxCost?: Money;
    readonly maxDurationMs?: number;
    readonly requiredPrivacy?: 'local-only' | 'no-training' | 'any-approved';
    readonly requiredFormats?: readonly string[];
    readonly preferredWorkerId?: string;
    readonly modelAllowlist?: readonly string[];
  };
  readonly idempotencyKey: string;
}

export interface ProviderPolicy {
  readonly allowRemote: boolean;
  readonly blockedProviders: readonly string[];
  readonly blockedCapabilities: readonly CapabilityId[];
  readonly maxCostPerRequest?: Money;
  readonly requireLocalFor: readonly CapabilityId[];
}

export interface ProviderResolution {
  readonly status: 'resolved' | 'ambiguous' | 'no-eligible' | 'blocked-by-policy';
  readonly provider?: AnyProvider;
  readonly candidates?: readonly AnyProvider[];
  readonly reason?: string;
}

// ===== Lifecycle Types =====

export type ProviderLifecycleState =
  'unconfigured' | 'configured' | 'healthy' | 'degraded' | 'offline' | 'unauthorized';

export interface ProviderStatus {
  readonly providerId: string;
  readonly state: ProviderLifecycleState;
  readonly lastHealthCheck?: string;
  readonly adapterVersion: string;
  readonly modelVersions?: readonly string[];
  readonly activeJobs: number;
  readonly lastError?: string;
  readonly consecutiveFailures: number;
}

// ===== Privacy Types =====

export interface PrivacyPreflight {
  readonly providerId: string;
  readonly capability: CapabilityId;
  readonly dataLeavesDevice: boolean;
  readonly dataBeingSent: string[];
  readonly purpose: string;
  readonly estimatedSizeBytes: number;
  readonly estimatedCost?: Money;
  readonly retentionDisclosure?: string;
  readonly transformations: string[];
  readonly requiresUserApproval: boolean;
}

// ===== Secret Types =====

export interface SecretHandle {
  readonly handleId: string;
  readonly providerId: string;
  readonly fieldName: string;
}

export interface SecretStore {
  set(handleId: string, value: string): Promise<void>;
  get(handleId: string): Promise<string | null>;
  delete(handleId: string): Promise<void>;
  redact(logLine: string, providerId: string): string;
}

// ===== Provenance Types =====

export interface GenerationProvenance {
  readonly providerId: string;
  readonly modelId: string;
  readonly adapterVersion: string;
  readonly createdAt: string;
  readonly requestHash: string;
  readonly idempotencyKey: string;
  readonly processingTimeMs: number;
  readonly execution: 'worker-local' | 'remote-api' | 'server' | 'browser';
}

export interface ProviderUsage {
  readonly providerId: string;
  readonly capability: CapabilityId;
  readonly modelId: string;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly cost?: Money;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly creditsUsed?: number;
}

export interface UsageRecord {
  readonly usages: readonly ProviderUsage[];
  readonly totalCost: Money;
  readonly periodStart: string;
  readonly periodEnd: string;
}

// ===== Result Types =====

export interface CapabilityResult {
  readonly requestId: string;
  readonly status: 'succeeded' | 'partial' | 'failed' | 'canceled';
  readonly outputs: readonly GeneratedOutput[];
  readonly provenance: GenerationProvenance;
  readonly usage?: ProviderUsage;
  readonly diagnostics: readonly Diagnostic[];
}

export interface GeneratedOutput {
  readonly kind: 'audio' | 'image' | 'video' | 'text' | 'data';
  readonly assetId: string;
  readonly mimeType: string;
  readonly bytes?: Uint8Array;
  readonly metadata?: Record<string, unknown>;
}

export interface Diagnostic {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
}
