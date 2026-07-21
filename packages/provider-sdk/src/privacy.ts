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
