import { useEffect, useState } from 'react';
import { CloseIcon, RefreshIcon } from './icons.js';
import {
  isDesktopHost,
  getDesktopAssetLibrarySettings,
  setDesktopAssetLibraryDirectory,
  selectDesktopAssetLibraryDirectory,
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
  const [notice, setNotice] = useState<{ kind: 'info' | 'success' | 'error'; message: string } | undefined>(
    undefined,
  );

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

  if (!open) return null;

  const handleSelectFolder = async () => {
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
      const defaultPath = 'H:\\VPS-DATA\\joy-media-assets';
      const updated = await setDesktopAssetLibraryDirectory(defaultPath);
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
        className="agent-settings-dialog joy-agent-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-library-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
        style={{ maxWidth: '640px' }}
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
          <p className="agent-settings-hint" style={{ marginTop: 0 }}>
            Configure the local folder where your audio, SFX, and graphic library assets are stored.
            You can change this path or point to an external drive at any time.
          </p>

          {!isDesktopHost() ? (
            <div className="agent-settings-notice is-info">
              <span>
                Local asset storage configuration is available when running inside the JOY Media Desktop application.
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

                <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={customPath}
                    onChange={(e) => setCustomPath(e.target.value)}
                    placeholder="e.g. H:\VPS-DATA\joy-media-assets"
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: '12px' }}
                  />
                  <button
                    type="button"
                    className="button-primary"
                    onClick={() => void handleSelectFolder()}
                    disabled={saving || loading}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    Change Folder…
                  </button>
                </div>

                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
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
                  className={`agent-settings-notice is-${notice.kind}`}
                  role="status"
                  aria-live="polite"
                  style={{ marginTop: '12px' }}
                >
                  <span className="agent-settings-notice-icon" aria-hidden="true">
                    {notice.kind === 'success' ? '✓' : notice.kind === 'error' ? '!' : 'i'}
                  </span>
                  <span>{notice.message}</span>
                </div>
              )}

              <section
                className="agent-settings-section"
                style={{
                  marginTop: '16px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  padding: '12px 16px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
              >
                <div className="agent-settings-section-heading">
                  <div>
                    <span className="agent-settings-kicker">Current Status</span>
                    <h3>Library Inspection</h3>
                  </div>
                  {settings?.exists && settings?.hasCatalog ? (
                    <span
                      style={{
                        color: '#4ade80',
                        fontSize: '12px',
                        fontWeight: 600,
                        background: 'rgba(74, 222, 128, 0.12)',
                        padding: '2px 8px',
                        borderRadius: '4px',
                      }}
                    >
                      ● Connected &amp; Ready
                    </span>
                  ) : (
                    <span
                      style={{
                        color: '#f87171',
                        fontSize: '12px',
                        fontWeight: 600,
                        background: 'rgba(248, 113, 113, 0.12)',
                        padding: '2px 8px',
                        borderRadius: '4px',
                      }}
                    >
                      ● Incomplete
                    </span>
                  )}
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '12px',
                    marginTop: '12px',
                  }}
                >
                  <div
                    style={{
                      background: 'rgba(0,0,0,0.2)',
                      padding: '8px 12px',
                      borderRadius: '4px',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '20px', fontWeight: 'bold' }}>
                      {settings?.counts.total ?? 0}
                    </div>
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>
                      Total Assets
                    </div>
                  </div>
                  <div
                    style={{
                      background: 'rgba(0,0,0,0.2)',
                      padding: '8px 12px',
                      borderRadius: '4px',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '20px', fontWeight: 'bold' }}>
                      {settings?.counts.audio ?? 0}
                    </div>
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>
                      Audio &amp; SFX
                    </div>
                  </div>
                  <div
                    style={{
                      background: 'rgba(0,0,0,0.2)',
                      padding: '8px 12px',
                      borderRadius: '4px',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '20px', fontWeight: 'bold' }}>
                      {settings?.counts.image ?? 0}
                    </div>
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>
                      Graphic Images
                    </div>
                  </div>
                </div>

                {!settings?.exists && (
                  <p style={{ color: '#f87171', fontSize: '12px', marginTop: '12px' }}>
                    Directory not found on this system. Please check your path or connect the external drive.
                  </p>
                )}
                {settings?.exists && !settings?.hasCatalog && (
                  <p style={{ color: '#fbbf24', fontSize: '12px', marginTop: '12px' }}>
                    Directory exists, but no catalog.json was found. Make sure catalog.json is present.
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
