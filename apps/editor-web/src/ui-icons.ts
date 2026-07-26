import { iconUrl } from './icon-assets.js';
/**
 * Uploaded 24×24 UI PNGs under `public/assets/icons/ui/`.
 * Prefer these for panel tabs / mute-mic chrome; CSS-mask them with currentColor.
 */

export const UI_ICONS = {
  assets: iconUrl('assets.png'),
  camera: iconUrl('camera.png'),
  grid: iconUrl('ui/4squares_24x24.png'),
  aiEffect: iconUrl('ui/ai-effect_24x24.png'),
  agentAi: iconUrl('ui/agent-ai_24x24.png'),
  capcut: iconUrl('ui/capcut_24x24.png'),
  effects: iconUrl('ui/effects_24x24.png'),
  effectsAlt: iconUrl('ui/effects2_24x24.png'),
  effectsOrg: iconUrl('ui/effects-org_24x24.png'),
  motion: iconUrl('ui/motion_24x24.png'),
  mic: iconUrl('ui/mic_24x24.png'),
  mute: iconUrl('ui/mute_24x24.png'),
  settings: iconUrl('ui/setting-gear_24x24.png'),
  inspect: iconUrl('ui/inspect_24x24.png'),
  speakerOn: iconUrl('ui/speaker-on_24x24.png'),
  speaker: iconUrl('ui/speaker_24x24.png'),
  transition: iconUrl('ui/transition_24x24.png'),
  /** Canonical name; source upload was misspelled `voice-cion`. */
  voice: iconUrl('ui/voice-icon_24x24.png'),
  voiceMemo: iconUrl('ui/voice-memo_24x24.png'),
  text: iconUrl('ui/t_24x24.png'),
  colors: iconUrl('ui/colors_24x24.png'),
  add: iconUrl('ui/add+_24x24.png'),
  blend: iconUrl('ui/blend_24x24.png'),
  blur: iconUrl('ui/blur_24x24.png'),
  /** Filename keeps upstream typo `brighness`. */
  brightness: iconUrl('ui/brighness_24x24.png'),
  brushSize: iconUrl('ui/brush-size_24x24.png'),
  brushSizeAlt: iconUrl('ui/brush-size2_24x24.png'),
  contrast: iconUrl('ui/contrast_24x24.png'),
  crop: iconUrl('ui/crop_24x24.png'),
  fullscreen: iconUrl('ui/full-screen_24x24.png'),
  gain: iconUrl('ui/gain_24x24.png'),
  gamma: iconUrl('ui/gamma_24x24.png'),
  invertColor: iconUrl('ui/invert-color_24x24.png'),
  lift: iconUrl('ui/lift_24x24.png'),
  saturation: iconUrl('ui/saturation_24x24.png'),
  timeline: iconUrl('ui/time-line_24x24.png'),
  timelineAlt: iconUrl('ui/time-line2_24x24.png'),
} as const;

export type UiIconId = keyof typeof UI_ICONS;
