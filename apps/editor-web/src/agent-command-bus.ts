import { CommandError } from '@joy-media/commands';
import type { CommandDispatchResult, CommandDispatcher } from '@joy-media/agent-tools';
import type { EditorSession } from './editor-session.js';

/**
 * WP-15.1: the real seam between `@joy-media/agent-tools`' edit tools and the
 * editor's actual, persisted, undoable timeline command bus. Wraps the exact
 * same `EditorSession.dispatchTimeline` the human Timeline panel uses (see
 * `App.tsx`'s `dispatchTimeline` callback) — an agent transaction becomes one
 * ordinary entry in the same undo/redo stack and the same local persistence
 * log, never a parallel or flattened mutation path (P06 goal, master plan
 * §36 Phase 6).
 *
 * There is still no agent-facing UI panel wired to this bus (WP-15.2); this
 * file only proves the dispatch path itself is real.
 */
export function createAgentCommandBus(session: EditorSession): CommandDispatcher {
  return {
    dispatchTimeline(commands, label): CommandDispatchResult {
      try {
        session.dispatchTimeline({ label, commands });
        return { success: true };
      } catch (error) {
        if (error instanceof CommandError) {
          return { success: false, error: `${error.code}: ${error.message}` };
        }
        throw error;
      }
    },
  };
}
