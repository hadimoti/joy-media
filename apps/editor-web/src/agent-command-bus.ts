import { CommandError } from '@joy-media/commands';
import type { CommandDispatchResult, CommandDispatcher } from '@joy-media/agent-tools';
import type { EditorSession } from './editor-session.js';
import { updateUniversalTimelineForTransaction } from './universal-placement.js';

/**
 * WP-15.1: the real seam between `@joy-media/agent-tools`' edit tools and the
 * editor's actual, persisted, undoable timeline command bus. Wraps the exact
 * same `EditorSession.dispatchTimeline` the human Timeline panel uses (see
 * `App.tsx`'s `dispatchTimeline` callback) — an agent transaction becomes one
 * ordinary entry in the same undo/redo stack and the same local persistence
 * log, never a parallel or flattened mutation path (P06 goal, master plan
 * §36 Phase 6).
 *
 * WP-15.2 wires this into the Agent panel. `onDispatched` lets the caller
 * (App.tsx) trigger a React re-render after a real mutation — mirroring the
 * existing `dispatchTimeline` callback's `setRevision` bump — since this bus
 * calls `EditorSession` directly rather than through that callback (it needs
 * to catch the real thrown `CommandError` and turn it into a `ToolResult`,
 * which the plain callback does not do).
 */
export function createAgentCommandBus(
  session: EditorSession,
  onDispatched?: () => void,
): CommandDispatcher {
  return {
    dispatchTimeline(commands, label): CommandDispatchResult {
      try {
        const timeline = { label, commands };
        const document = updateUniversalTimelineForTransaction(session.visualProject, timeline);
        if (document === session.visualProject) session.dispatchTimeline(timeline);
        else session.dispatchCompound(label, { timeline, document });
        return { success: true };
      } catch (error) {
        if (error instanceof CommandError) {
          return { success: false, error: `${error.code}: ${error.message}` };
        }
        throw error;
      } finally {
        onDispatched?.();
      }
    },
  };
}
