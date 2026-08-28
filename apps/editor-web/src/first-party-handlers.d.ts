import { type NodeLibrary } from '@joy-media/workflow-engine';
import type { EditorSession } from './editor-session.js';
export interface FirstPartyLibraryStatus {
    readonly available: boolean;
    readonly label: 'Unavailable' | 'Available';
    readonly reason: string;
    readonly recovery: string;
}
declare const PRODUCTION_LIBRARY_MARKER: "__joyMediaProductionFirstParty";
type MarkedProductionLibrary = NodeLibrary & {
    readonly [PRODUCTION_LIBRARY_MARKER]: true;
};
/**
 * Build the production browser library. Fixture PCM and deferred synthetic
 * successes are intentionally not wired here; unsupported ports fail closed
 * through `workflow/port-unavailable:*` until a real media/provider adapter is
 * injected.
 */
export declare function createProductionFirstPartyLibrary(): MarkedProductionLibrary;
export declare function getProductionFirstPartyLibraryStatus(): FirstPartyLibraryStatus;
export declare function isProductionFirstPartyLibrary(library: NodeLibrary): boolean;
/**
 * Connect only the editor port to the real local editor session.
 *
 * This is deliberately an explicit injection seam: all analysis, generation,
 * render, and output ports stay unavailable unless a caller wires real
 * adapters for them. The editor port accepts timeline commands only and routes
 * them through EditorSession.dispatchTimeline, which gives the workflow the
 * same persistence, history, undo, redo, and reload semantics as a human edit.
 */
export declare function createEditorSessionFirstPartyLibrary(session: EditorSession): NodeLibrary;
/** Build a NodeLibrary whose ports are deterministic fixtures suitable for tests. */
export declare function createFixtureFirstPartyLibrary(): NodeLibrary;
export {};
//# sourceMappingURL=first-party-handlers.d.ts.map