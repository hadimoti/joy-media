import type { ComponentType } from 'react';
import { iconUrl } from './icon-assets.js';
import { BrowseIcon, FilmIcon, ImageIcon, SpeakerOnIcon } from './icons.js';
import type { AssetCategory, AssetCollectionId } from './asset-library-state.js';

/**
 * The section glyphs of the Asset Library. They come from the shared outline
 * set (T-D09), so the library's tabs have the same weight and colour as the
 * rest of the app.
 */
export const ASSET_CATEGORY_ICONS: Readonly<Record<AssetCategory, ComponentType>> = {
  all: BrowseIcon,
  image: ImageIcon,
  video: FilmIcon,
  audio: SpeakerOnIcon,
};

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
