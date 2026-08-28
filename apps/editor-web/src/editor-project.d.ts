import type { JoyProjectV1 } from '@joy-media/project-schema';
/** Default monitor / composition size (portrait Reels / Shorts). */
export declare const DEFAULT_COMPOSITION_SIZE: Readonly<{
    width: 1080;
    height: 1920;
}>;
/** Pre-v7 landscape default — migrated to {@link DEFAULT_COMPOSITION_SIZE} on open. */
export declare const LEGACY_COMPOSITION_SIZE: Readonly<{
    width: 1920;
    height: 1080;
}>;
/**
 * If the root composition still has the old landscape default, rewrite it to
 * portrait. Custom sizes (anything other than the legacy pair) are left alone.
 */
export declare function withDefaultPortraitComposition(project: JoyProjectV1): JoyProjectV1;
/** The project document stays outside React's ephemeral editor state. */
export declare const INITIAL_EDITOR_PROJECT: JoyProjectV1;
export declare const TIMELINE_OBJECT_IDS: Readonly<Record<string, readonly string[]>>;
//# sourceMappingURL=editor-project.d.ts.map