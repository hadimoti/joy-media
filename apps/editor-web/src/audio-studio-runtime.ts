export type AudioAtomicApiId =
  | 'audio.denoise'
  | 'audio.enhance'
  | 'audio.separate'
  | 'audio.clone_voice'
  | 'audio.tts'
  | 'audio.convert_voice'
  | 'audio.eq'
  | 'audio.compress'
  | 'audio.reverb'
  | 'audio.limit'
  | 'audio.normalize'
  | 'audio.master'
  | 'audio.repair'
  | 'audio.mix'
  | 'audio.pitch_shift'
  | 'audio.time_stretch';

export type AudioExecutionTarget = 'local-worker' | 'browser-dsp' | 'vps-orchestrated';
export type AudioModelInstallState = 'installed' | 'available' | 'update';

export interface AudioResourceEstimate {
  readonly ramGb: number;
  readonly vramGb: number;
  readonly diskGb: number;
}

export interface AudioAtomicCapability {
  readonly id: AudioAtomicApiId;
  readonly label: string;
  readonly provider: string;
  readonly target: AudioExecutionTarget;
  readonly modelId?: string;
  readonly resources: AudioResourceEstimate;
}

export interface AudioModelSpec {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly version: string;
  readonly sizeGb: number;
  readonly ramGb: number;
  readonly vramGb: number;
  readonly gpu: 'required' | 'preferred' | 'optional';
  readonly quantization: string;
  readonly installState: AudioModelInstallState;
  readonly localPath: string;
  readonly capabilities: readonly AudioAtomicApiId[];
}

export interface AudioWorkflowPreset {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly steps: readonly AudioAtomicApiId[];
}

export interface AudioWorkflowGraph {
  readonly presetId: string;
  readonly nodes: readonly { readonly id: AudioAtomicApiId; readonly label: string }[];
  readonly edges: readonly { readonly from: AudioAtomicApiId; readonly to: AudioAtomicApiId }[];
}

export const DEFAULT_MODEL_CACHE_PATH = 'C:\\Users\\<user>\\JOY\\models';

export const AUDIO_ATOMIC_CAPABILITIES: readonly AudioAtomicCapability[] = [
  {
    id: 'audio.denoise',
    label: 'Denoise',
    provider: 'DeepFilterNet',
    target: 'local-worker',
    modelId: 'deepfilternet-v3',
    resources: { ramGb: 2, vramGb: 2, diskGb: 0.4 },
  },
  {
    id: 'audio.enhance',
    label: 'Enhance',
    provider: 'Speech Enhancement',
    target: 'local-worker',
    modelId: 'speech-enhance-xl',
    resources: { ramGb: 4, vramGb: 4, diskGb: 1.8 },
  },
  {
    id: 'audio.separate',
    label: 'Separate',
    provider: 'Demucs',
    target: 'local-worker',
    modelId: 'demucs-htdemucs',
    resources: { ramGb: 5, vramGb: 4, diskGb: 1.2 },
  },
  {
    id: 'audio.clone_voice',
    label: 'Clone Voice',
    provider: 'Voice Identity',
    target: 'local-worker',
    modelId: 'qwen3-tts',
    resources: { ramGb: 8, vramGb: 8, diskGb: 4.2 },
  },
  {
    id: 'audio.tts',
    label: 'TTS',
    provider: 'Qwen3-TTS',
    target: 'local-worker',
    modelId: 'qwen3-tts',
    resources: { ramGb: 8, vramGb: 8, diskGb: 4.2 },
  },
  {
    id: 'audio.convert_voice',
    label: 'Convert Voice',
    provider: 'RVC',
    target: 'local-worker',
    modelId: 'rvc-v2',
    resources: { ramGb: 4, vramGb: 4, diskGb: 1.4 },
  },
  {
    id: 'audio.eq',
    label: 'EQ',
    provider: 'Audio Core',
    target: 'browser-dsp',
    resources: { ramGb: 0.2, vramGb: 0, diskGb: 0 },
  },
  {
    id: 'audio.compress',
    label: 'Compress',
    provider: 'Audio Core',
    target: 'browser-dsp',
    resources: { ramGb: 0.2, vramGb: 0, diskGb: 0 },
  },
  {
    id: 'audio.reverb',
    label: 'Reverb',
    provider: 'Audio Core',
    target: 'browser-dsp',
    resources: { ramGb: 0.4, vramGb: 0, diskGb: 0 },
  },
  {
    id: 'audio.limit',
    label: 'Limiter',
    provider: 'Audio Core',
    target: 'browser-dsp',
    resources: { ramGb: 0.2, vramGb: 0, diskGb: 0 },
  },
  {
    id: 'audio.normalize',
    label: 'Normalize',
    provider: 'Audio Core',
    target: 'browser-dsp',
    resources: { ramGb: 0.2, vramGb: 0, diskGb: 0 },
  },
  {
    id: 'audio.master',
    label: 'Master',
    provider: 'JOY Graph',
    target: 'vps-orchestrated',
    resources: { ramGb: 0.5, vramGb: 0, diskGb: 0 },
  },
  {
    id: 'audio.repair',
    label: 'Repair',
    provider: 'Repair Chain',
    target: 'local-worker',
    modelId: 'audio-repair-local',
    resources: { ramGb: 4, vramGb: 4, diskGb: 2.3 },
  },
  {
    id: 'audio.mix',
    label: 'Mix',
    provider: 'Audio Core',
    target: 'browser-dsp',
    resources: { ramGb: 0.3, vramGb: 0, diskGb: 0 },
  },
  {
    id: 'audio.pitch_shift',
    label: 'Pitch Shift',
    provider: 'Rubber Band',
    target: 'local-worker',
    modelId: 'rubberband-local',
    resources: { ramGb: 1, vramGb: 0, diskGb: 0.1 },
  },
  {
    id: 'audio.time_stretch',
    label: 'Time Stretch',
    provider: 'Rubber Band',
    target: 'local-worker',
    modelId: 'rubberband-local',
    resources: { ramGb: 1, vramGb: 0, diskGb: 0.1 },
  },
];

export const AUDIO_MODEL_CATALOG: readonly AudioModelSpec[] = [
  {
    id: 'qwen3-tts',
    name: 'Qwen3-TTS',
    provider: 'Qwen',
    version: 'local-runtime',
    sizeGb: 4.2,
    ramGb: 8,
    vramGb: 8,
    gpu: 'preferred',
    quantization: 'int8 / fp16',
    installState: 'available',
    localPath: `${DEFAULT_MODEL_CACHE_PATH}\\qwen3-tts`,
    capabilities: ['audio.tts', 'audio.clone_voice'],
  },
  {
    id: 'deepfilternet-v3',
    name: 'DeepFilterNet',
    provider: 'DeepFilterNet',
    version: 'v3',
    sizeGb: 0.4,
    ramGb: 2,
    vramGb: 2,
    gpu: 'optional',
    quantization: 'fp32',
    installState: 'available',
    localPath: `${DEFAULT_MODEL_CACHE_PATH}\\deepfilternet`,
    capabilities: ['audio.denoise'],
  },
  {
    id: 'demucs-htdemucs',
    name: 'Demucs HTDemucs',
    provider: 'Meta',
    version: 'htdemucs',
    sizeGb: 1.2,
    ramGb: 5,
    vramGb: 4,
    gpu: 'preferred',
    quantization: 'fp32',
    installState: 'available',
    localPath: `${DEFAULT_MODEL_CACHE_PATH}\\demucs`,
    capabilities: ['audio.separate'],
  },
  {
    id: 'speech-enhance-xl',
    name: 'Speech Enhance',
    provider: 'JOY Audio',
    version: 'xl-local',
    sizeGb: 1.8,
    ramGb: 4,
    vramGb: 4,
    gpu: 'preferred',
    quantization: 'fp16',
    installState: 'available',
    localPath: `${DEFAULT_MODEL_CACHE_PATH}\\speech-enhance`,
    capabilities: ['audio.enhance', 'audio.repair'],
  },
  {
    id: 'rubberband-local',
    name: 'Rubber Band',
    provider: 'DSP Engine',
    version: '3.x',
    sizeGb: 0.1,
    ramGb: 1,
    vramGb: 0,
    gpu: 'optional',
    quantization: 'native',
    installState: 'installed',
    localPath: `${DEFAULT_MODEL_CACHE_PATH}\\rubberband`,
    capabilities: ['audio.pitch_shift', 'audio.time_stretch'],
  },
];

export const AUDIO_WORKFLOW_PRESETS: readonly AudioWorkflowPreset[] = [
  {
    id: 'podcast-quality',
    label: 'Podcast Quality',
    command: 'Clean this voice and make it podcast quality.',
    steps: [
      'audio.denoise',
      'audio.enhance',
      'audio.eq',
      'audio.compress',
      'audio.limit',
      'audio.normalize',
    ],
  },
  {
    id: 'youtube-master',
    label: 'YouTube Master',
    command: 'Master this interview for YouTube.',
    steps: ['audio.denoise', 'audio.enhance', 'audio.compress', 'audio.limit', 'audio.master'],
  },
  {
    id: 'voice-design',
    label: 'Voice Design',
    command: 'Clone, convert, and place this voice.',
    steps: ['audio.clone_voice', 'audio.tts', 'audio.convert_voice', 'audio.normalize'],
  },
  {
    id: 'music-stems',
    label: 'Music Stems',
    command: 'Separate vocals and music, then remix.',
    steps: ['audio.separate', 'audio.mix', 'audio.master'],
  },
  {
    id: 'audio-repair',
    label: 'Audio Repair',
    command: 'Repair damaged dialogue.',
    steps: ['audio.repair', 'audio.denoise', 'audio.enhance', 'audio.normalize'],
  },
];

export function getAudioCapability(id: AudioAtomicApiId): AudioAtomicCapability {
  const capability = AUDIO_ATOMIC_CAPABILITIES.find((item) => item.id === id);
  if (capability === undefined) {
    throw new Error(`unknown audio capability ${id}`);
  }
  return capability;
}

export function buildAudioWorkflowGraph(presetId: string): AudioWorkflowGraph {
  const preset = AUDIO_WORKFLOW_PRESETS.find((item) => item.id === presetId);
  if (preset === undefined) {
    throw new Error(`unknown audio workflow ${presetId}`);
  }

  const nodes = preset.steps.map((id) => ({ id, label: getAudioCapability(id).label }));
  const edges = preset.steps.slice(1).map((to, index) => ({ from: preset.steps[index]!, to }));
  return { presetId, nodes, edges };
}

export function getDefaultAudioModel(capabilityId: AudioAtomicApiId): AudioModelSpec | undefined {
  return AUDIO_MODEL_CATALOG.find((model) => model.capabilities.includes(capabilityId));
}

export function summarizeLocalAudioResources(capabilityIds: readonly AudioAtomicApiId[]) {
  const modelIds = new Set<string>();
  let ramGb = 0;
  let vramGb = 0;
  let diskGb = 0;

  for (const id of capabilityIds) {
    const capability = getAudioCapability(id);
    if (capability.modelId !== undefined) modelIds.add(capability.modelId);
    ramGb = Math.max(ramGb, capability.resources.ramGb);
    vramGb = Math.max(vramGb, capability.resources.vramGb);
    diskGb += capability.resources.diskGb;
  }

  return { ramGb, vramGb, diskGb: Number(diskGb.toFixed(1)), modelCount: modelIds.size };
}
