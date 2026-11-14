import { useEffect, useState, type ReactElement } from 'react';
import {
  closeDesktopWindow,
  isDesktopHost,
  isDesktopWindowMaximized,
  minimizeDesktopWindow,
  toggleMaximizeDesktopWindow,
} from './desktop-client.js';

/**
 * Minimize, maximize / restore and close for the frameless desktop window. The editor header and the
 * Projects page both show it, so the window can be managed from every screen. Renders nothing in a
 * browser. The maximize state is read from the host and refreshed on resize.
 */
export function WindowControls(): ReactElement | null {
  const [isMaximized, setIsMaximized] = useState(false);
  const desktop = isDesktopHost();

  useEffect(() => {
    if (!desktop) return undefined;
    const update = () => {
      void isDesktopWindowMaximized()
        .then(setIsMaximized)
        .catch(() => {});
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [desktop]);

  if (!desktop) return null;
  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button
        type="button"
        className="window-control-btn window-control-minimize"
        onClick={() => {
          minimizeDesktopWindow().catch((err) => console.error('Failed to minimize window:', err));
        }}
        title="Minimize"
        aria-label="Minimize window"
      >
        <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
          <rect width="10" height="1" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control-btn window-control-maximize"
        onClick={() => {
          toggleMaximizeDesktopWindow()
            .then((isMax) => setIsMaximized(isMax))
            .catch((err) => console.error('Failed to toggle maximize window:', err));
        }}
        title={isMaximized ? 'Restore' : 'Maximize'}
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            <rect x="2.5" y="0.5" width="7" height="7" strokeWidth="1" />
            <polyline points="0.5,2.5 0.5,9.5 7.5,9.5 7.5,7.5" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            <rect x="0.5" y="0.5" width="9" height="9" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-control-btn window-control-close"
        onClick={() => {
          closeDesktopWindow().catch((err) => console.error('Failed to close window:', err));
        }}
        title="Close"
        aria-label="Close window"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2">
          <line x1="0" y1="0" x2="10" y2="10" />
          <line x1="10" y1="0" x2="0" y2="10" />
        </svg>
      </button>
    </div>
  );
}
