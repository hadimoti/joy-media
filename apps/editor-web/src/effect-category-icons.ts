import { iconUrl } from './icon-assets.js';

/**
 * Owner-supplied 24×24 category masks for the Effects left rail.
 * The art ships with the app. Favorites uses the
 * shared StarIcon instead of a PNG.
 */
export const EFFECT_CATEGORY_ICONS: Readonly<Record<string, string>> = {
  recipes: iconUrl('effect/24_Recipe.png'),
  // The panel's own categories (T-V06). The art is the owner's; the rail now
  // names the Filter or Effect groups instead of the registry's categories.
  'colour-light': iconUrl('effect/24_color.png'),
  'depth-shadow': iconUrl('effect/24_depth.png'),
  'distort-move': iconUrl('effect/24_distort.png'),
  'drawn-printed': iconUrl('effect/24_artistic.png'),
  'edge-detail': iconUrl('effect/24_stylize.png'),
  'retro-screen': iconUrl('effect/24_pixel.png'),
};

export function effectCategoryIconUrl(categoryId: string): string | undefined {
  return EFFECT_CATEGORY_ICONS[categoryId];
}
