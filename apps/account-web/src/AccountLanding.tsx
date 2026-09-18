import { useState, useEffect, type ReactNode } from 'react';
import {
  fetchSubscription,
  fetchDevices,
  fetchAgentUsage,
  revokeDevice,
  logoutSession,
  type UserSession,
  type ReleaseInfo,
  type SubscriptionInfo,
  type DeviceInfo,
  type AgentUsageSummary,
} from './api.js';

interface AccountLandingProps {
  readonly user: UserSession;
  readonly release: ReleaseInfo | null;
  readonly onLogout: () => void;
}

export function AccountLanding({ user, release, onLogout }: AccountLandingProps): ReactNode {
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [devices, setDevices] = useState<readonly DeviceInfo[]>([]);
  const [usage, setUsage] = useState<AgentUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedSha, setCopiedSha] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function loadData() {
      setLoading(true);
      try {
        const [subData, devData, usageData] = await Promise.all([
          fetchSubscription(),
          fetchDevices(),
          fetchAgentUsage(),
        ]);
        if (!mounted) return;
        setSubscription(subData);
        setDevices(devData);
        setUsage(usageData);
      } catch (err) {
        console.error('Failed to load dashboard data:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void loadData();
    return () => {
      mounted = false;
    };
  }, []);

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      await revokeDevice(id);
      setDevices((prev) => prev.filter((d) => d.id !== id));
      setActionNotice('Device access revoked successfully.');
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : 'Failed to revoke device');
    } finally {
      setRevokingId(null);
    }
  };

  const copyChecksum = () => {
    if (!release?.sha256) return;
    navigator.clipboard.writeText(release.sha256).then(() => {
      setCopiedSha(true);
      setTimeout(() => setCopiedSha(false), 2000);
    });
  };

  const handleSignOut = async () => {
    await logoutSession();
    onLogout();
  };

  return (
    <div className="account-dashboard-container">
      {/* Dashboard Top Header */}
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <img src="/assets/JoyCodeNew_32x32.png" alt="JOY Media" width={28} height={28} />
          <span className="dashboard-brand-title">JOY Media</span>
          <span className="dashboard-brand-pill">Creator Dashboard</span>
        </div>

        <div className="dashboard-user-bar">
          <div className="user-profile-badge">
            <span className="user-avatar-circle">
              {user.contact.charAt(0).toUpperCase()}
            </span>
            <div className="user-profile-info">
              <span className="user-profile-name">{user.displayName || user.contact}</span>
              <span className="user-profile-type">
                {user.method === 'gmail' ? 'Gmail Verified' : 'Telegram Verified'}
              </span>
            </div>
          </div>

          <button type="button" className="dashboard-logout-btn" onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </header>

      {/* Main Content Grid */}
      <main className="dashboard-main-content">
        {actionNotice && <div className="dashboard-action-notice">{actionNotice}</div>}

        {/* 1. Installer & Download Card */}
        <section className="dashboard-card is-highlight">
          <div className="card-header">
            <div>
              <span className="card-kicker">Desktop Client</span>
              <h2>Download JOY Media for Windows</h2>
            </div>
            <span className="version-tag">Version {release?.version || '1.0.0'} (Stable)</span>
          </div>

          <p className="card-desc">
            Download the full desktop NLE package. Includes the embedded <code>joy-worker.exe</code> local
            GPU processing daemon, local SQLite WAL engine, and instant asset library streaming.
          </p>

          <div className="download-actions-row">
            <a
              href={release?.downloadUrl || '/releases/joy-media-windows-x64-v1.0.0.zip'}
              className="dash-btn-download"
              download
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download Windows Package (x64)
            </a>

            <div className="checksum-container">
              <span className="checksum-label">SHA-256 Checksum:</span>
              <code className="checksum-code">{release?.sha256 || 'Calculating…'}</code>
              <button type="button" className="copy-checksum-btn" onClick={copyChecksum}>
                {copiedSha ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="install-guide-box">
            <h4>Quick Installation:</h4>
            <ol>
              <li>Extract the downloaded archive or run <code>Setup-JoyMedia.ps1</code>.</li>
              <li>Launch <strong>JOY Media</strong> from your Start Menu or Desktop shortcut.</li>
              <li>Your workstation runs completely offline. To use Joy Model AI, click the account icon in the app header and sign in with this Gmail address.</li>
            </ol>
          </div>
        </section>

        {/* 2. Subscription & Plan Status */}
        <section className="dashboard-card">
          <div className="card-header">
            <div>
              <span className="card-kicker">License & Entitlement</span>
              <h3>Subscription Status</h3>
            </div>
            <span className={`status-pill status-${subscription?.status || 'none'}`}>
              {subscription?.status === 'active' ? 'Active' : subscription?.status === 'expired' ? 'Expired' : 'Free / Trial'}
            </span>
          </div>

          <div className="subscription-details-grid">
            <div className="sub-detail-item">
              <span className="sub-detail-label">Current Plan</span>
              <span className="sub-detail-value">
                {subscription?.plan === 'monthly' ? 'JOY Pro Monthly' : subscription?.plan === 'yearly' ? 'JOY Pro Yearly' : 'Standard Creator'}
              </span>
            </div>
            <div className="sub-detail-item">
              <span className="sub-detail-label">Renewal / Period End</span>
              <span className="sub-detail-value">
                {subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleDateString() : 'Lifetime Local / No Expiry'}
              </span>
            </div>
            <div className="sub-detail-item">
              <span className="sub-detail-label">Joy Model Gateway</span>
              <span className="sub-detail-value">
                {subscription?.status === 'active' ? 'Enabled (Curated Models)' : 'Requires Active Pro'}
              </span>
            </div>
          </div>
        </section>

        {/* 3. Authorized Devices */}
        <section className="dashboard-card">
          <div className="card-header">
            <div>
              <span className="card-kicker">Device Security</span>
              <h3>Authorized Workstations ({devices.length})</h3>
            </div>
          </div>

          <p className="card-desc">
            Devices registered to your JOY account. You can revoke access from any workstation at any time.
          </p>

          {loading ? (
            <p className="empty-hint">Loading registered devices…</p>
          ) : devices.length === 0 ? (
            <div className="empty-devices-box">
              <p>No external workstations registered yet.</p>
              <span>Install the Windows app and sign in to register your PC automatically.</span>
            </div>
          ) : (
            <ul className="devices-list">
              {devices.map((device) => (
                <li key={device.id} className="device-row">
                  <div className="device-meta">
                    <span className="device-icon">💻</span>
                    <div>
                      <strong>{device.displayName}</strong>
                      <span className="device-date">
                        Registered: {new Date(device.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="device-revoke-btn"
                    disabled={revokingId === device.id}
                    onClick={() => handleRevoke(device.id)}
                  >
                    {revokingId === device.id ? 'Revoking…' : 'Revoke'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 4. Joy Model Gateway Usage Ledger */}
        <section className="dashboard-card">
          <div className="card-header">
            <div>
              <span className="card-kicker">AI Intelligence</span>
              <h3>Joy Model Token Usage</h3>
            </div>
          </div>

          <div className="usage-stats-grid">
            <div className="stat-box">
              <span className="stat-label">Total AI Requests</span>
              <span className="stat-value">{usage?.totalRequests ?? 0}</span>
            </div>
            <div className="stat-box">
              <span className="stat-label">Prompt Tokens</span>
              <span className="stat-value">{(usage?.totalPromptTokens ?? 0).toLocaleString()}</span>
            </div>
            <div className="stat-box">
              <span className="stat-label">Completion Tokens</span>
              <span className="stat-value">{(usage?.totalCompletionTokens ?? 0).toLocaleString()}</span>
            </div>
            <div className="stat-box">
              <span className="stat-label">Estimated Spend</span>
              <span className="stat-value">${(usage?.totalCostUsd ?? 0).toFixed(4)}</span>
            </div>
          </div>
          <p className="usage-footnote">
            ℹ️ Token usage is measured transparently at cost + 25% margin. BYOK calls directly to your own keys are not logged or metered.
          </p>
        </section>
      </main>
    </div>
  );
}
