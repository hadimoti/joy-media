import type {
  AnyProvider,
  CapabilityId,
  CapabilityRequest,
  Money,
  PrivacyPreflight,
} from './types.js';
import {
  getProviderId,
  getDataLeavesDevice,
  getExecution,
  isRemoteExecution,
  getCapabilityDeclaration,
} from './utils.js';

const CAPABILITY_DATA_TYPES: Record<CapabilityId, string[]> = {
  'speech.transcribe': ['audio data'],
  'speech.align': ['audio data', 'text data'],
  'speech.diarize': ['audio data'],
  'speech.synthesize': ['text data'],
  'voice.clone': ['audio samples', 'voice profile'],
  'audio.denoise': ['audio data'],
  'audio.separate': ['audio data'],
  'music.generate': ['text prompt'],
  'image.generate': ['text prompt'],
  'image.edit': ['image data', 'text prompt'],
  'image.removeBackground': ['image data'],
  'image.upscale': ['image data'],
  'video.generate': ['text prompt'],
  'video.animate': ['image data', 'text prompt'],
  'video.interpolate': ['video frames'],
  'video.removeBackground': ['video data'],
  'llm.complete': ['text prompt'],
  'embedding.create': ['text data'],
  'vision.analyze': ['image data'],
};

const CAPABILITY_PURPOSES: Record<CapabilityId, string> = {
  'speech.transcribe': 'Transcribe audio to text',
  'speech.align': 'Align audio with text',
  'speech.diarize': 'Identify speakers in audio',
  'speech.synthesize': 'Synthesize speech from text',
  'voice.clone': 'Clone voice from samples',
  'audio.denoise': 'Remove noise from audio',
  'audio.separate': 'Separate audio sources',
  'music.generate': 'Generate music from prompt',
  'image.generate': 'Generate image from prompt',
  'image.edit': 'Edit image based on prompt',
  'image.removeBackground': 'Remove background from image',
  'image.upscale': 'Upscale image resolution',
  'video.generate': 'Generate video from prompt',
  'video.animate': 'Animate image to video',
  'video.interpolate': 'Interpolate video frames',
  'video.removeBackground': 'Remove background from video',
  'llm.complete': 'Complete text generation',
  'embedding.create': 'Create text embedding',
  'vision.analyze': 'Analyze image content',
};

const DEFAULT_SIZE_ESTIMATES: Record<CapabilityId, number> = {
  'speech.transcribe': 5_000_000,
  'speech.align': 5_000_000,
  'speech.diarize': 5_000_000,
  'speech.synthesize': 1_000,
  'voice.clone': 10_000_000,
  'audio.denoise': 5_000_000,
  'audio.separate': 5_000_000,
  'music.generate': 1_000,
  'image.generate': 1_000,
  'image.edit': 2_000_000,
  'image.removeBackground': 2_000_000,
  'image.upscale': 2_000_000,
  'video.generate': 1_000,
  'video.animate': 5_000_000,
  'video.interpolate': 50_000_000,
  'video.removeBackground': 50_000_000,
  'llm.complete': 5_000,
  'embedding.create': 5_000,
  'vision.analyze': 2_000_000,
};

const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export interface ProviderApprovalBinding {
  readonly actorId: string;
  readonly providerId: string;
  readonly capability: CapabilityId;
  readonly requestDigest: string;
  readonly expiresAt: string;
  readonly costCap?: Money;
}

export interface ProviderApprovalGrant extends ProviderApprovalBinding {
  readonly grantVersion: 1;
  readonly grantId: string;
  readonly grantSignature: string;
  readonly status: 'approved' | 'denied';
}

export interface ProviderApprovalPreflight extends PrivacyPreflight {
  readonly requestDigest: string;
  readonly approvalRequiredReason?: 'remote-processing' | 'provider-spend';
}

export function computePrivacyPreflight(
  request: CapabilityRequest,
  provider: AnyProvider,
): PrivacyPreflight {
  const providerId = getProviderId(provider);
  const dataLeavesDeviceRaw = getDataLeavesDevice(provider);
  const execution = getExecution(provider);
  const isRemote = isRemoteExecution(execution);

  const dataLeavesDevice =
    dataLeavesDeviceRaw === true || (dataLeavesDeviceRaw === 'depends' && isRemote);

  const dataBeingSent = CAPABILITY_DATA_TYPES[request.capability] ?? ['unknown data'];
  const purpose = CAPABILITY_PURPOSES[request.capability] ?? `Execute ${request.capability}`;
  const estimatedSizeBytes = DEFAULT_SIZE_ESTIMATES[request.capability] ?? 1_000_000;

  const decl = getCapabilityDeclaration(provider, request.capability);
  let estimatedCost: Money | undefined;
  if (decl?.pricing) {
    estimatedCost = { amount: decl.pricing.rate, currency: decl.pricing.currency };
  }

  const transformations: string[] = [];
  if (isRemote) {
    transformations.push('remote API call');
  }
  if (request.capability === 'speech.transcribe' || request.capability === 'speech.diarize') {
    transformations.push('audio-only extraction');
  }

  const requiresUserApproval = dataLeavesDevice && isRemote;

  const retentionDisclosure =
    'protocolVersion' in provider.manifest
      ? provider.manifest.privacy.retentionDisclosure
      : undefined;

  const result: PrivacyPreflight = {
    providerId,
    capability: request.capability,
    dataLeavesDevice,
    dataBeingSent,
    purpose,
    estimatedSizeBytes,
    transformations,
    requiresUserApproval,
  };

  if (estimatedCost !== undefined) {
    (result as { estimatedCost?: Money }).estimatedCost = estimatedCost;
  }
  if (retentionDisclosure !== undefined) {
    (result as { retentionDisclosure?: string }).retentionDisclosure = retentionDisclosure;
  }

  return result;
}

export function computeProviderRequestDigest(request: CapabilityRequest): string {
  return `sha256:${sha256Hex(stableJson(request))}`;
}

export function computeProviderApprovalPreflight(
  actorId: string,
  request: CapabilityRequest,
  provider: AnyProvider,
): ProviderApprovalPreflight {
  const preflight = computePrivacyPreflight(request, provider);
  return {
    ...preflight,
    requestDigest: computeProviderRequestDigest(requestForApprovalDigest(actorId, request)),
    ...(preflight.requiresUserApproval
      ? { approvalRequiredReason: 'remote-processing' as const }
      : preflight.estimatedCost !== undefined
        ? { approvalRequiredReason: 'provider-spend' as const }
        : {}),
  };
}

function requestForApprovalDigest(
  actorId: string,
  request: CapabilityRequest,
): CapabilityRequest<{ readonly actorId: string; readonly input: unknown }> {
  return {
    ...request,
    input: {
      actorId,
      input: request.input,
    },
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const bitLength = data.length * 8;
  const paddedLength = (((data.length + 8) >> 6) + 1) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(data);
  bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64).fill(0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;

    for (let i = 0; i < 64; i++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  return h.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}
