/** The eight transition categories of card T-V08, in the order the panel rail shows them. */
export const TRANSITION_CATEGORIES = [
  { id: 'basic-fades', label: 'Basic and fades' },
  { id: 'wipes', label: 'Wipes' },
  { id: 'slides-pushes', label: 'Slides and pushes' },
  { id: 'zooms-spins', label: 'Zooms and spins' },
  { id: 'shapes-masks', label: 'Shapes and masks' },
  { id: 'glitch-digital', label: 'Glitch and digital' },
  { id: 'light-glow', label: 'Light and glow' },
  { id: 'creative', label: 'Creative' },
] as const;

export type TransitionCategoryId = (typeof TRANSITION_CATEGORIES)[number]['id'];

/**
 * Options a catalogue entry offers. `duration` is the junction length every transition has;
 * `direction` and `colour` are listed only where the entry really has them. `easing` is part of
 * the vocabulary but no entry offers it yet: the project schema stores no easing for a transition.
 */
export const TRANSITION_OPTIONS = ['duration', 'direction', 'easing', 'colour'] as const;

export type TransitionOption = (typeof TRANSITION_OPTIONS)[number];

export function isTransitionCategoryId(value: string): value is TransitionCategoryId {
  return TRANSITION_CATEGORIES.some((category) => category.id === value);
}

export function isTransitionOption(value: string): value is TransitionOption {
  return (TRANSITION_OPTIONS as readonly string[]).includes(value);
}
