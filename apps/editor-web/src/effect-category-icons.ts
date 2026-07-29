import { iconUrl } from './icon-assets.js';

/**
 * Owner-supplied 24×24 category masks for the Effects left rail.
 * Same art as https://media.joyteam.ir/assets/24_*.png — Favorites uses the
 * shared StarIcon instead of a PNG.
 */
export const EFFECT_CATEGORY_ICONS: Readonly<Record<string, string>> = {
  recipes: iconUrl('effect/24_Recipe.png'),
  'pixel-bw': iconUrl('effect/24_pixel.png'),
  color: iconUrl('effect/24_color.png'),
  stylize: iconUrl('effect/24_stylize.png'),
  artistic: iconUrl('effect/24_artistic.png'),
  blur: iconUrl('effect/24_blur.png'),
  distort: iconUrl('effect/24_distort.png'),
  depth: iconUrl('effect/24_depth.png'),
};

export function effectCategoryIconUrl(categoryId: string): string | undefined {
  return EFFECT_CATEGORY_ICONS[categoryId];
}
