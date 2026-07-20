export interface AudioClipConfig {
  readonly gain: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly solo: boolean;
  readonly fadeInUs?: number;
  readonly fadeOutUs?: number;
}

export interface AudioBus {
  readonly id: string;
  readonly name: string;
  readonly gain: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly solo: boolean;
  readonly inputs: readonly string[];
}

export interface EqBand {
  readonly frequency: number;
  readonly gain: number;
  readonly q: number;
  readonly type: 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'lowshelf' | 'highshelf';
}

export type AudioEffect =
  | { readonly kind: 'eq'; readonly bands: readonly EqBand[] }
  | {
      readonly kind: 'compressor';
      readonly threshold: number;
      readonly ratio: number;
      readonly attackUs: number;
      readonly releaseUs: number;
      readonly knee: number;
    }
  | { readonly kind: 'limiter'; readonly ceiling: number; readonly releaseUs: number }
  | {
      readonly kind: 'gate';
      readonly threshold: number;
      readonly attackUs: number;
      readonly releaseUs: number;
      readonly holdUs: number;
    };

export interface AudioEffectInstance {
  readonly id: string;
  readonly targetId: string;
  readonly effect: AudioEffect;
}

export interface AudioGraphState {
  readonly clips: Readonly<Record<string, AudioClipConfig>>;
  readonly buses: readonly AudioBus[];
  readonly effects: readonly AudioEffectInstance[];
}

export const DEFAULT_CLIP_CONFIG: AudioClipConfig = {
  gain: 1.0,
  pan: 0,
  mute: false,
  solo: false,
};
