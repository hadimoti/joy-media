/**
 * Content template types (ADR-0027a §1.0).
 *
 * A content template is a declaration of what to build — clips, visual objects,
 * scene overlays — not a saved project. The builder turns these into
 * CommandTransaction + VisualObjectTransaction pairs that land as one undo step.
 *
 * Unlike ADR-0027 workflow templates, duplicate application of the same seed is
 * allowed: a user may want two title overlays or two lower-thirds.
 */

import type { FirstPartySceneId } from '@joy-media/html-scene-runtime/first-party';

export interface ContentTemplateV1 {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Logical group for UX filtering: Titles, Lower Thirds, Social, Effects, Utility */
  readonly category: string;
  /** Optional asset ID for the preview thumbnail shown in the card grid */
  readonly previewAssetId?: string;
  /** Ordered list of actions this template performs when applied */
  readonly actions: readonly ContentTemplateAction[];
}

export type ContentTemplateAction = HtmlSceneAction;

export interface HtmlSceneAction {
  readonly kind: 'html-scene';
  readonly sceneId: FirstPartySceneId;
}

/**
 * A template ready for application, paired with a seed for deterministic ID
 * generation. Mirrors the `TemplateSeed` pattern from ADR-0027 but drops the
 * `range` field since content templates don't bind to a selection.
 */
export interface SeededContentTemplate {
  readonly template: ContentTemplateV1;
  readonly seed: string;
  readonly scopeLabel?: string;
}

export type { FirstPartySceneId };
