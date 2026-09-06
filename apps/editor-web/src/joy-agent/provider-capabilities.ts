/**
 * Pure provider capability assessment for the browser BYOK boundary.
 *
 * This module deliberately accepts only opaque, already-collected provider
 * transcript values. It does not accept a BYOK configuration, does not fetch,
 * and does not persist or return raw provider data. The Worker transport added
 * in a later F3 slice owns collection and must discard its raw transcript once
 * this small, redacted assessment has been produced.
 */

export const PROVIDER_CAPABILITY_STATES = ['structured-tools', 'plan-only', 'unavailable'] as const;

export type ProviderCapabilityState = (typeof PROVIDER_CAPABILITY_STATES)[number];

/** A user policy can restrict a capable provider, but must never upgrade one. */
export const PROVIDER_EXECUTION_POLICIES = ['prefer-structured-tools', 'plan-only'] as const;

export type ProviderExecutionPolicy = (typeof PROVIDER_EXECUTION_POLICIES)[number];
export type ProviderExecutionMode = ProviderCapabilityState;

export const PROVIDER_TOOL_PROBE_RESULT =
  '{"ok":true,"probe":"joy-provider-capability-v1"}' as const;
export const PROVIDER_TOOL_PROBE_CONTINUATION_TOKEN = 'JOY_PROVIDER_PROBE_CONTINUED_V1' as const;

/**
 * Exact acknowledgement required from a provider after one tiny,
 * product-owned synthetic media request. It is deliberately unrelated to the
 * structured-tool probe above: media support never upgrades tool capability.
 */
export const PROVIDER_MEDIA_CAPABILITY_PROBE_ACK = 'JOY_MEDIA_CAPABILITY_PROBE_OK_V1' as const;
export const PROVIDER_MEDIA_CAPABILITY_MODALITIES = ['image', 'audio', 'video'] as const;

export type ProviderMediaCapabilityModality = (typeof PROVIDER_MEDIA_CAPABILITY_MODALITIES)[number];
export type ProviderMediaCapabilityState = 'supported' | 'unavailable';

/**
 * Raw provider envelopes stay on the Worker side. This shape is an input only
 * to the pure validator; none of it is exposed in the returned assessment.
 */
export interface ProviderMediaCapabilityProbe {
  readonly image?: { readonly response: unknown };
  readonly audio?: { readonly response: unknown };
  readonly video?: { readonly response: unknown };
}

/** Redacted modality facts, with no endpoint, credential, or provider text. */
export interface ProviderMediaCapabilityAssessment {
  readonly image: ProviderMediaCapabilityState;
  readonly audio: ProviderMediaCapabilityState;
  readonly video: ProviderMediaCapabilityState;
  /** Canonical subset of the three independently validated fields. */
  readonly modalities: readonly ProviderMediaCapabilityModality[];
}

export type ProviderCapabilityDiagnostic =
  | 'structured-tool-proven'
  | 'plan-only-proven'
  | 'provider-probe-missing'
  | 'structured-tool-definition-invalid'
  | 'structured-tool-response-invalid'
  | 'structured-tool-call-missing'
  | 'structured-tool-call-ambiguous'
  | 'structured-tool-call-id-invalid'
  | 'structured-tool-name-mismatch'
  | 'structured-tool-arguments-invalid'
  | 'structured-tool-continuation-missing'
  | 'structured-tool-continuation-invalid'
  | 'plan-only-response-invalid';

export interface ProviderStructuredToolDefinition {
  /** Product-owned, bounded function name expected from the provider. */
  readonly name: string;
  /**
   * Product-owned schema predicate for the parsed JSON arguments. It must be
   * pure: never use configuration, storage, a network request, or transcript
   * values outside the parsed arguments passed here.
   */
  readonly validateArguments: (value: unknown) => boolean;
}

export interface ProviderStructuredToolProbeTranscript {
  /** Raw response to the forced named-tool probe request. */
  readonly initialResponse: unknown;
  /** Raw payload sent for the request after JOY supplied the probe tool result. */
  readonly continuationRequest: unknown;
  /** Raw response returned after that tool-result request. */
  readonly continuationResponse: unknown;
}

export interface ProviderStructuredToolProbe {
  readonly tool: ProviderStructuredToolDefinition;
  readonly transcript: ProviderStructuredToolProbeTranscript;
}

export interface ProviderPlanOnlyProbe {
  /** Raw response to a separately issued, no-tools text probe. */
  readonly response: unknown;
}

export interface ProviderCapabilityProbe {
  /** Structured-tool proof takes precedence only when the full chain validates. */
  readonly structuredTool?: ProviderStructuredToolProbe;
  /** A distinct no-tools probe; it is not inferred from a failed tool probe. */
  readonly planOnly?: ProviderPlanOnlyProbe;
}

export interface ProviderStructuredToolProof {
  readonly kind: 'structured-tool-probe';
  /** The product-owned expected tool name, never a provider-supplied string. */
  readonly toolName: string;
}

export interface ProviderCapabilityAssessment {
  readonly state: ProviderCapabilityState;
  readonly diagnostic: ProviderCapabilityDiagnostic;
  readonly proof?: ProviderStructuredToolProof;
}

/**
 * Prove each media modality independently. Any absent, malformed, oversized,
 * rejected, or non-acknowledging provider response is simply unavailable. The
 * assessment intentionally never preserves raw response values.
 */
export function assessProviderMediaCapabilities(probe: unknown): ProviderMediaCapabilityAssessment {
  const candidate = isRecord(probe) ? probe : undefined;
  const stateFor = (modality: ProviderMediaCapabilityModality): ProviderMediaCapabilityState =>
    isMediaProbeResponseValid(candidate?.[modality]) ? 'supported' : 'unavailable';
  const image = stateFor('image');
  const audio = stateFor('audio');
  const video = stateFor('video');
  const modalities = PROVIDER_MEDIA_CAPABILITY_MODALITIES.filter(
    (modality) => ({ image, audio, video })[modality] === 'supported',
  );
  return Object.freeze({
    image,
    audio,
    video,
    modalities: Object.freeze(modalities),
  });
}

interface ParsedProbeCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsText: string;
}

type StructuredProbeResult =
  | { readonly ok: true; readonly proof: ProviderStructuredToolProof }
  | { readonly ok: false; readonly diagnostic: ProviderCapabilityDiagnostic };

const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_CALL_ID_LENGTH = 128;
const MAX_ARGUMENT_BYTES = 8_192;
const MAX_PLAN_ONLY_TEXT_BYTES = 8_192;
const SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const SAFE_TOOL_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Classify provider compatibility from ephemeral probe evidence. The result is
 * intentionally metadata-only: it contains neither credentials nor endpoint,
 * transcript, model reply, tool arguments, or tool call identifier.
 */
export function assessProviderCapabilities(probe: unknown): ProviderCapabilityAssessment {
  const candidate = isRecord(probe) ? probe : undefined;
  const rawStructuredTool = candidate?.structuredTool;
  const structured =
    rawStructuredTool === undefined
      ? ({ ok: false, diagnostic: 'provider-probe-missing' } as const)
      : validateStructuredToolProbe(rawStructuredTool);
  if (structured.ok) {
    return Object.freeze({
      state: 'structured-tools',
      diagnostic: 'structured-tool-proven',
      proof: structured.proof,
    });
  }

  if (candidate?.planOnly !== undefined) {
    // A present-but-invalid plan-only probe means the provider replied badly,
    // which is distinct from "no probe was collected".
    if (isPlanOnlyProbeValid(candidate.planOnly))
      return Object.freeze({ state: 'plan-only', diagnostic: 'plan-only-proven' });
    return Object.freeze({ state: 'unavailable', diagnostic: 'plan-only-response-invalid' });
  }

  return Object.freeze({ state: 'unavailable', diagnostic: structured.diagnostic });
}

/**
 * Keep factual provider support separate from the user's execution policy.
 * Choosing plan-only never makes an unavailable provider usable, and choosing
 * structured tools never upgrades a plan-only provider.
 */
export function resolveProviderExecutionMode(
  capability: ProviderCapabilityState,
  policy: ProviderExecutionPolicy,
): ProviderExecutionMode {
  if (capability === 'unavailable') return 'unavailable';
  if (policy === 'plan-only') return 'plan-only';
  return capability;
}

function validateStructuredToolProbe(probe: unknown): StructuredProbeResult {
  if (!isRecord(probe) || !isRecord(probe.tool) || !isRecord(probe.transcript)) {
    return { ok: false, diagnostic: 'structured-tool-definition-invalid' };
  }
  const tool = probe.tool;
  const transcript = probe.transcript;
  const toolName = tool.name;
  const validateArguments = tool.validateArguments;
  if (!isSafeToolName(toolName) || !isArgumentValidator(validateArguments)) {
    return { ok: false, diagnostic: 'structured-tool-definition-invalid' };
  }

  const initialMessage = extractProviderMessage(transcript.initialResponse);
  if (
    initialMessage === undefined ||
    (initialMessage.role !== undefined && initialMessage.role !== 'assistant')
  )
    return { ok: false, diagnostic: 'structured-tool-response-invalid' };

  const call = parseExpectedProbeCall(initialMessage, toolName, validateArguments);
  if (!call.ok) return call;

  const continuation = validateContinuation(
    transcript.continuationRequest,
    transcript.continuationResponse,
    call.call,
  );
  if (continuation !== undefined) return { ok: false, diagnostic: continuation };

  return {
    ok: true,
    proof: Object.freeze({ kind: 'structured-tool-probe', toolName }),
  };
}

function parseExpectedProbeCall(
  message: Readonly<Record<string, unknown>>,
  toolName: string,
  validateArguments: (value: unknown) => boolean,
): StructuredProbeResult & { readonly call?: ParsedProbeCall } {
  const calls = message.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0)
    return { ok: false, diagnostic: 'structured-tool-call-missing' };
  if (calls.length !== 1) return { ok: false, diagnostic: 'structured-tool-call-ambiguous' };

  const call = calls[0];
  if (!isRecord(call) || !isSafeToolCallId(call.id))
    return { ok: false, diagnostic: 'structured-tool-call-id-invalid' };
  if (call.type !== 'function' || !isRecord(call.function))
    return { ok: false, diagnostic: 'structured-tool-response-invalid' };
  if (call.function.name !== toolName)
    return { ok: false, diagnostic: 'structured-tool-name-mismatch' };
  if (
    typeof call.function.arguments !== 'string' ||
    byteLength(call.function.arguments) > MAX_ARGUMENT_BYTES
  ) {
    return { ok: false, diagnostic: 'structured-tool-arguments-invalid' };
  }

  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.function.arguments);
  } catch {
    return { ok: false, diagnostic: 'structured-tool-arguments-invalid' };
  }
  try {
    if (!validateArguments(argumentsValue))
      return { ok: false, diagnostic: 'structured-tool-arguments-invalid' };
  } catch {
    return { ok: false, diagnostic: 'structured-tool-arguments-invalid' };
  }

  return {
    ok: true,
    proof: Object.freeze({ kind: 'structured-tool-probe', toolName }),
    call: {
      id: call.id,
      name: toolName,
      argumentsText: call.function.arguments,
    },
  };
}

function validateContinuation(
  rawRequest: unknown,
  rawResponse: unknown,
  initialCall: ParsedProbeCall | undefined,
): 'structured-tool-continuation-missing' | 'structured-tool-continuation-invalid' | undefined {
  if (initialCall === undefined || !isRecord(rawRequest) || !Array.isArray(rawRequest.messages))
    return 'structured-tool-continuation-missing';
  const messages = rawRequest.messages;
  const last = messages.at(-1);
  if (
    !isRecord(last) ||
    last.role !== 'tool' ||
    last.tool_call_id !== initialCall.id ||
    last.content !== PROVIDER_TOOL_PROBE_RESULT
  ) {
    return 'structured-tool-continuation-missing';
  }

  const echoedCall = messages.slice(0, -1).some((message) => {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.tool_calls))
      return false;
    return message.tool_calls.some((call) => {
      if (!isRecord(call) || !isRecord(call.function)) return false;
      return (
        call.id === initialCall.id &&
        call.type === 'function' &&
        call.function.name === initialCall.name &&
        call.function.arguments === initialCall.argumentsText
      );
    });
  });
  if (!echoedCall) return 'structured-tool-continuation-missing';

  const continuationMessage = extractProviderMessage(rawResponse);
  if (
    continuationMessage === undefined ||
    (continuationMessage.role !== undefined && continuationMessage.role !== 'assistant') ||
    continuationMessage.content !== PROVIDER_TOOL_PROBE_CONTINUATION_TOKEN ||
    (continuationMessage.tool_calls !== undefined &&
      (!Array.isArray(continuationMessage.tool_calls) ||
        continuationMessage.tool_calls.length !== 0))
  ) {
    return 'structured-tool-continuation-invalid';
  }
  return undefined;
}

function isPlanOnlyProbeValid(probe: unknown): boolean {
  if (!isRecord(probe)) return false;
  const message = extractProviderMessage(probe.response);
  return (
    message !== undefined &&
    (message.role === undefined || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0 &&
    byteLength(message.content) <= MAX_PLAN_ONLY_TEXT_BYTES &&
    (message.tool_calls === undefined ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length === 0))
  );
}

/**
 * The acknowledgement is intentionally exact and text-only. A provider's
 * ordinary prose, an echoed synthetic payload, a tool call, or an arbitrary
 * JSON object cannot be mistaken for media support.
 */
function isMediaProbeResponseValid(probe: unknown): boolean {
  if (!isRecord(probe) || !Object.prototype.hasOwnProperty.call(probe, 'response')) return false;
  const message = extractProviderMessage(probe.response);
  return (
    message !== undefined &&
    message.role === 'assistant' &&
    message.content === PROVIDER_MEDIA_CAPABILITY_PROBE_ACK &&
    message.tool_calls === undefined
  );
}

function extractProviderMessage(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0)
    return undefined;
  const firstChoice = value.choices[0];
  return isRecord(firstChoice) && isRecord(firstChoice.message) ? firstChoice.message : undefined;
}

function isSafeToolName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TOOL_NAME_LENGTH &&
    SAFE_TOOL_NAME.test(value)
  );
}

function isSafeToolCallId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TOOL_CALL_ID_LENGTH &&
    SAFE_TOOL_CALL_ID.test(value)
  );
}

function isArgumentValidator(value: unknown): value is (value: unknown) => boolean {
  return typeof value === 'function';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
