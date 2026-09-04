import { iconUrl } from './icon-assets.js';
import type { BrowserStockVideoCategory } from './control-plane-client.js';
import type { AssetCategory, AssetCollectionId } from './asset-library-state.js';

/**
 * Owner-supplied 24×24 black-on-transparent masks for Assets sections and
 * collection tabs. Same art as https://media.joyteam.ir/assets/24_*.png —
 * imported through Vite so redeploys bust CDN/browser caches.
 */
export const ASSET_CATEGORY_ICONS: Readonly<Record<AssetCategory, string>> = {
  all: iconUrl('asset/24_Browse.png'),
  image: iconUrl('asset/24_Images.png'),
  video: iconUrl('asset/24_video.png'),
  audio: iconUrl('asset/24_Audio.png'),
};

/** Stable local masks for the native stock category rail. */
export const STOCK_VIDEO_CATEGORY_ICONS: Readonly<Record<BrowserStockVideoCategory, string>> = {
  'business-work': iconUrl('ui/charts.png'),
  technology: iconUrl('asset/24_UI.png'),
  'people-lifestyle': iconUrl('24_socials.png'),
  nature: iconUrl('24_scenes.png'),
  'travel-places': iconUrl('camera.png'),
  'city-transport': iconUrl('asset/24_arrows.png'),
  'food-drink': iconUrl('asset/24_creative.png'),
  'abstract-backgrounds': iconUrl('asset/24_patterns.png'),
};

export function stockVideoCategoryIconUrl(id: BrowserStockVideoCategory): string {
  return STOCK_VIDEO_CATEGORY_ICONS[id];
}

const COLLECTION_ICONS: Readonly<Record<string, string>> = {
  browse: iconUrl('asset/24_Browse.png'),
  elements: iconUrl('asset/24_creative.png'),
  logo: iconUrl('asset/24_Brand.png'),
  arrow: iconUrl('asset/24_arrows.png'),
  effects: iconUrl('ui/effects-org_24x24.png'),
  icon: iconUrl('asset/24_Icons.png'),
  illustration: iconUrl('asset/24_illustrator.png'),
  pattern: iconUrl('asset/24_patterns.png'),
  photo: iconUrl('asset/24_Images.png'),
  shape: iconUrl('asset/24_Shapes.png'),
  text: iconUrl('asset/24_Text.png'),
  ui: iconUrl('asset/24_UI.png'),
  clips: iconUrl('asset/24_video.png'),
  tracks: iconUrl('asset/24_Audio.png'),
  transition: iconUrl('ui/transition_24x24.png'),
};

export function assetCollectionIconUrl(id: AssetCollectionId): string | undefined {
  if (id === 'browse') return COLLECTION_ICONS.browse;
  const slug = id.slice('category:'.length);
  return COLLECTION_ICONS[slug];
}
