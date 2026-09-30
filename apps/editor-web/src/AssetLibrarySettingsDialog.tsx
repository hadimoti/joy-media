import { useEffect, useRef, useState } from 'react';
import { CloseIcon, RefreshIcon } from './icons.js';
import {
  isDesktopHost,
  getDesktopAssetLibrarySettings,
  setDesktopAssetLibraryDirectory,
  selectDesktopAssetLibraryDirectory,
  resetDesktopAssetLibraryDirectory,
  type DesktopAssetLibrarySettings,
} from './desktop-client.js';

export interface AssetLibrarySettingsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDirectoryChanged?: () => void;
}

export function AssetLibrarySettingsDialog({
  open,
  onClose,
  onDirectoryChanged,
}: AssetLibrarySettingsDialogProps) {
  const [settings, setSettings] = useState<DesktopAssetLibrarySettings | undefined>(undefined);
  const [customPath, setCustomPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<
    { kind: 'info' | 'success' | 'error'; message: string } | undefined
  >(undefined);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const restorePickerFocus = useRef(false);

  const loadSettings = async () => {
    if (!isDesktopHost()) return;
    setLoading(true);
    try {
      const data = await getDesktopAssetLibrarySettings();
      setSettings(data);
      setCustomPath(data.directory);
    } catch (err: unknown) {
      setNotice({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load asset library settings',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setNotice(undefined);
      void loadSettings();
    }
  }, [open]);

  useEffect(() => {
    if (saving || !restorePickerFocus.current) return;
    restorePickerFocus.current = false;
    pickerButtonRef.current?.focus();
  }, [saving]);

  if (!open) return null;

  const handleSelectFolder = async () => {
    restorePickerFocus.current = true;
    setSaving(true);
    setNotice(undefined);
    try {
      const updated = await selectDesktopAssetLibraryDirectory();
      if (updated) {
        setSettings(updated);
        setCustomPath(updated.directory);
        setNotice({
          kind: 'success',
          message: `Asset library folder updated to: ${updated.directory}`,
        });
        onDirectoryChanged?.();
      }
    } catch (err: unknown) {
      setNotice({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to select directory',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleApplyCustomPath = async () => {
    if (!customPath.trim()) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const updated = await setDesktopAssetLibraryDirectory(customPath.trim());
      setSettings(updated);
      setCustomPath(updated.directory);
      setNotice({
        kind: 'success',
        message: `Asset library folder updated to: ${updated.directory}`,
      });
      onDirectoryChanged?.();
    } catch (err: unknown) {
      setNotice({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to set directory',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefault = async () => {
    setSaving(true);
    setNotice(undefined);
    try {
      const updated = await resetDesktopAssetLibraryDirectory();
      setSettings(updated);
      setCustomPath(updated.directory);
      setNotice({
        kind: 'success',
        message: 'Reset asset library folder to default location.',
      });
      onDirectoryChanged?.();
    } catch (err: unknown) {
      setNotice({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to reset directory',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="agent-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="agent-settings-dialog joy-agent-settings-dialog asset-library-storage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-library-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="agent-settings-header">
          <div>
            <span className="agent-settings-kicker">Application Settings</span>
            <h2 id="asset-library-settings-title">Asset Library Storage</h2>
          </div>
          <button
            type="button"
            className="agent-settings-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="agent-settings-body">
          <p className="agent-settings-hint asset-library-storage-hint">
            Configure the local folder where your audio, SFX, and graphic library assets are stored.
            You can change this path or point to an external drive at any time.
          </p>

          {!isDesktopHost() ? (
            <div className="agent-settings-notice is-info">
              <span>
                Local asset storage configuration is available when running inside the JOY Media
                Desktop application.
              </span>
            </div>
          ) : (
            <>
              <section className="agent-settings-section">
                <div className="agent-settings-section-heading">
                  <div>
                    <span className="agent-settings-kicker">Storage Location</span>
                    <h3>Local Assets Folder</h3>
                  </div>
                  {settings?.isDefault && (
                    <span className="agent-settings-session-chip">Default Path</span>
                  )}
                </div>

                <div className="asset-library-storage-path-row">
                  <input
                    type="text"
                    value={customPath}
                    onChange={(e) => setCustomPath(e.target.value)}
                    placeholder="/path/to/asset/library"
                    className="asset-library-storage-path-input"
                  />
                  <button
                    type="button"
                    className="button-primary asset-library-storage-picker-btn"
                    ref={pickerButtonRef}
                    onClick={() => void handleSelectFolder()}
                    disabled={saving || loading}
                  >
                    Change Folder…
                  </button>
                </div>

                <div className="asset-library-storage-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void handleApplyCustomPath()}
                    disabled={saving || loading || customPath === settings?.directory}
                  >
                    Apply Path
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void handleResetDefault()}
                    disabled={saving || loading || settings?.isDefault}
                  >
                    Reset to Default
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void loadSettings()}
                    disabled={saving || loading}
                    title="Refresh folder status"
                  >
                    <RefreshIcon />
                  </button>
                </div>
              </section>

              {notice && (
                <div
                  className={`agent-settings-notice is-${notice.kind} asset-library-storage-notice`}
                  role="status"
                  aria-live="polite"
                >
                  <span className="agent-settings-notice-icon" aria-hidden="true">
                    {notice.kind === 'success' ? '✓' : notice.kind === 'error' ? '!' : 'i'}
                  </span>
                  <span>{notice.message}</span>
                </div>
              )}

              <section className="agent-settings-section asset-library-storage-inspection">
                <div className="agent-settings-section-heading">
                  <div>
                    <span className="agent-settings-kicker">Current Status</span>
                    <h3>Library Inspection</h3>
                  </div>
                  {settings?.exists && settings?.hasCatalog ? (
                    <span className="asset-library-storage-chip is-ready">
                      ● Connected &amp; Ready
                    </span>
                  ) : (
                    <span className="asset-library-storage-chip is-incomplete">● Incomplete</span>
                  )}
                </div>

                <div className="asset-library-storage-count-grid">
                  <div className="asset-library-storage-count-card">
                    <div className="asset-library-storage-count-value">
                      {settings?.counts.total ?? 0}
                    </div>
                    <div className="asset-library-storage-count-label">Total Assets</div>
                  </div>
                  <div className="asset-library-storage-count-card">
                    <div className="asset-library-storage-count-value">
                      {settings?.counts.audio ?? 0}
                    </div>
                    <div className="asset-library-storage-count-label">Audio &amp; SFX</div>
                  </div>
                  <div className="asset-library-storage-count-card">
                    <div className="asset-library-storage-count-value">
                      {settings?.counts.image ?? 0}
                    </div>
                    <div className="asset-library-storage-count-label">Graphic Images</div>
                  </div>
                </div>

                {!settings?.exists && (
                  <p className="asset-library-storage-warning">
                    Directory not found on this system. Please check your path or connect the
                    external drive.
                  </p>
                )}
                {settings?.exists && !settings?.hasCatalog && (
                  <p className="asset-library-storage-warning is-warning">
                    Directory exists, but no catalog.json was found. Make sure catalog.json is
                    present.
                  </p>
                )}
                {settings?.isDefault && !settings.hasCatalog && (
                  <p className="asset-library-storage-warning is-warning" role="note">
                    If you upgraded and your previous Asset Library is missing, use Change Folder…
                    to reconnect its existing folder. Changing this setting only points JOY Media to
                    that folder; files are not moved or deleted.
                  </p>
                )}
              </section>
            </>
          )}
        </div>

        <footer className="agent-settings-footer">
          <button type="button" className="button-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
