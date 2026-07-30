/**
 * First-party content template catalog.
 *
 * Seeds 10 templates from the existing 30 first-party HTML scenes in
 * `@joy-media/html-scene-runtime/first-party`. These are the initial Library
 * tab entries in the Templates panel.
 */

import type { ContentTemplateV1 } from './content-template-types.js';

export const CONTENT_TEMPLATES: readonly ContentTemplateV1[] = [
  {
    id: 'joy.title',
    label: 'JOY Title',
    description: 'Main title with subtitle and accent color',
    category: 'Titles',
    actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
  },
  {
    id: 'joy.product-card',
    label: 'Product Card',
    description: 'Product showcase card with pricing',
    category: 'Titles',
    actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.product-card' }],
  },
  {
    id: 'joy.title-cinematic',
    label: 'Cinematic Title',
    description: 'Cinematic opening with classic typography',
    category: 'Titles',
    actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title-cinematic' }],
  },
  {
    id: 'joy.lower-third-bar',
    label: 'Lower Third Bar',
    description: 'Name and title bar at the bottom of the screen',
    category: 'Lower Thirds',
    actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.lower-third-bar' }],
  },
  {
    id: 'joy.end-slate',
    label: 'End Slate',
    description: 'End screen with title and call to action',
    category: 'Utility',
    actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.end-slate' }],
  },
  {
    id: 'joy.neon-sign',
    label: 'Neon Sign',
    description: 'Glowing neon text with light effects',
    category: 'Effects',
    actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.neon-sign' }],
  },
  {
    id: 'joy.photo-stack',
    label: 'Photo Stack',
    description: 'Staggered photo stack with depth effect',
    category: 'Effects',
    actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.photo-stack' }],
  },
  {
    id: 'joy.social-badge',
    label: 'Social Badge',
    description: 'Social media badge with handle and icon',
    category: 'Social',
    actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.social-badge' }],
  },
  {
    id: 'joy.countdown',
    label: 'Countdown',
    description: 'Animated number countdown timer',
    category: 'Utility',
    actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.countdown' }],
  },
  {
    id: 'joy.spotlight-quote',
    label: 'Spotlight Quote',
    description: 'Highlighted quote with spotlight and dark background',
    category: 'Titles',
    actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.spotlight-quote' }],
  },
];

export function contentTemplateById(id: string): ContentTemplateV1 | undefined {
  return CONTENT_TEMPLATES.find((candidate) => candidate.id === id);
}
