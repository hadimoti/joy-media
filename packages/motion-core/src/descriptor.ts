/**
 * MotionDescriptor — the unified envelope for every motion in the library.
 * Both original 4 presets and user-created motions share this format.
 */

import type { MotionSceneDocument } from './scene.js';

export type MotionSource = 'built-in' | 'user' | 'shared';

export type MotionCategory =
  | 'fade'
  | 'slide'
  | 'scale'
  | 'bounce'
  | 'blur'
  | 'text'
  | 'title'
  | 'lower-third'
  | 'logo'
  | 'social'
  | 'overlay'
  | 'transition'
  | 'background'
  | 'glitch'
  | 'custom';

export type AspectSupport = '9:16' | '16:9' | '1:1' | '4:5' | '3:4';

export type MotionCapability =
  | 'text-editing'
  | 'font-import'
  | 'image-replace'
  | 'variable-expose'
  | 'responsive-variant'
  | 'custom-css'
  | 'custom-js'
  | 'loop';

export interface MotionPreviewDescriptor {
  readonly posterUrl?: string;
  readonly previewUrl?: string;
}

export interface MotionDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly source: MotionSource;
  readonly version: number;
  readonly schemaVersion: number;
  readonly category: MotionCategory;
  readonly tags: readonly string[];
  readonly durationMs: number;
  readonly loop: boolean;
  readonly aspectSupport: readonly AspectSupport[];
  readonly scene: MotionSceneDocument;
  readonly preview?: MotionPreviewDescriptor;
  readonly capabilities: readonly MotionCapability[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}
