/**
 * Uploaded 24×24 UI PNGs under `public/assets/icons/ui/`.
 * Prefer these for panel tabs / mute-mic chrome; CSS-mask them with currentColor.
 */

export const UI_ICONS = {
  assets: '/assets/icons/assets.png',
  camera: '/assets/icons/camera.png',
  grid: '/assets/icons/ui/4squares_24x24.png',
  aiEffect: '/assets/icons/ui/ai-effect_24x24.png',
  agentAi: '/assets/icons/ui/agent-ai_24x24.png',
  capcut: '/assets/icons/ui/capcut_24x24.png',
  effects: '/assets/icons/ui/effects_24x24.png',
  effectsAlt: '/assets/icons/ui/effects2_24x24.png',
  effectsOrg: '/assets/icons/ui/effects-org_24x24.png',
  mic: '/assets/icons/ui/mic_24x24.png',
  mute: '/assets/icons/ui/mute_24x24.png',
  settings: '/assets/icons/ui/setting-gear_24x24.png',
  inspect: '/assets/icons/ui/inspect_24x24.png',
  speakerOn: '/assets/icons/ui/speaker-on_24x24.png',
  speaker: '/assets/icons/ui/speaker_24x24.png',
  transition: '/assets/icons/ui/transition_24x24.png',
  /** Canonical name; source upload was misspelled `voice-cion`. */
  voice: '/assets/icons/ui/voice-icon_24x24.png',
  voiceMemo: '/assets/icons/ui/voice-memo_24x24.png',
  text: '/assets/icons/ui/t_24x24.png',
  colors: '/assets/icons/ui/colors_24x24.png',
  add: '/assets/icons/ui/add+_24x24.png',
  blend: '/assets/icons/ui/blend_24x24.png',
  blur: '/assets/icons/ui/blur_24x24.png',
  /** Filename keeps upstream typo `brighness`. */
  brightness: '/assets/icons/ui/brighness_24x24.png',
  brushSize: '/assets/icons/ui/brush-size_24x24.png',
  brushSizeAlt: '/assets/icons/ui/brush-size2_24x24.png',
  contrast: '/assets/icons/ui/contrast_24x24.png',
  crop: '/assets/icons/ui/crop_24x24.png',
  fullscreen: '/assets/icons/ui/full-screen_24x24.png',
  gain: '/assets/icons/ui/gain_24x24.png',
  gamma: '/assets/icons/ui/gamma_24x24.png',
  invertColor: '/assets/icons/ui/invert-color_24x24.png',
  lift: '/assets/icons/ui/lift_24x24.png',
  saturation: '/assets/icons/ui/saturation_24x24.png',
  timeline: '/assets/icons/ui/time-line_24x24.png',
  timelineAlt: '/assets/icons/ui/time-line2_24x24.png',
} as const;

export type UiIconId = keyof typeof UI_ICONS;
