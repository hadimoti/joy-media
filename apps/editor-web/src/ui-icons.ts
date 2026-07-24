/**
 * Uploaded 24×24 UI PNGs under `public/assets/icons/ui/`.
 * Prefer these for panel tabs / mute-mic chrome; CSS-mask them with currentColor.
 */

export const UI_ICONS = {
  grid: '/assets/icons/ui/4squares_24x24.png',
  aiEffect: '/assets/icons/ui/ai-effect_24x24.png',
  capcut: '/assets/icons/ui/capcut_24x24.png',
  effects: '/assets/icons/ui/effects_24x24.png',
  effectsAlt: '/assets/icons/ui/effects2_24x24.png',
  effectsOrg: '/assets/icons/ui/effects-org_24x24.png',
  mic: '/assets/icons/ui/mic_24x24.png',
  mute: '/assets/icons/ui/mute_24x24.png',
  settings: '/assets/icons/ui/setting-gear_24x24.png',
  speakerOn: '/assets/icons/ui/speaker-on_24x24.png',
  transition: '/assets/icons/ui/transition_24x24.png',
  /** Canonical name; source upload was misspelled `voice-cion`. */
  voice: '/assets/icons/ui/voice-icon_24x24.png',
} as const;

export type UiIconId = keyof typeof UI_ICONS;
