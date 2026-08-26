import { useRef, useState } from 'react';
import {
  VisualObjectProjectHistory,
  type VisualObjectTransaction,
} from '@joy-media/property-system';
import { CaptionsPanel } from '../src/CaptionsPanel.js';
import { INITIAL_EDITOR_PROJECT } from '../src/editor-project.js';

/** Stateful browser-test harness that exercises the real caption command history. */
export function CaptionInteractionHarness() {
  const history = useRef(new VisualObjectProjectHistory(INITIAL_EDITOR_PROJECT));
  const [revision, setRevision] = useState(0);
  const [dispatchCount, setDispatchCount] = useState(0);
  void revision;

  const renderHistory = () => setRevision((current) => current + 1);
  const dispatch = (transaction: VisualObjectTransaction) => {
    history.current.apply(transaction);
    setDispatchCount((current) => current + 1);
    renderHistory();
  };

  return (
    <main>
      <nav aria-label="Caption test history">
        <button
          type="button"
          disabled={!history.current.canUndo}
          onClick={() => {
            history.current.undo();
            renderHistory();
          }}
        >
          Harness undo
        </button>
        <button
          type="button"
          disabled={!history.current.canRedo}
          onClick={() => {
            history.current.redo();
            renderHistory();
          }}
        >
          Harness redo
        </button>
        <output data-testid="dispatch-count">{dispatchCount}</output>
      </nav>
      <CaptionsPanel
        project={history.current.present}
        playheadUs={2_000_000}
        onSeek={() => undefined}
        onDispatch={dispatch}
        onTranscribe={() => Promise.resolve()}
        transcriptionAvailability={{ state: 'unavailable', reason: 'Select supported media.' }}
        transcriptionError={undefined}
        onProjectChange={(project) => {
          history.current.replacePresent(project);
          renderHistory();
        }}
      />
    </main>
  );
}
