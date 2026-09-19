import { useState, useEffect, type ReactNode } from 'react';
import {
  fetchUserSession,
  fetchLatestRelease,
  type UserSession,
  type ReleaseInfo,
} from './api.js';
import { LandingHero } from './LandingHero.js';
import { AccountLanding } from './AccountLanding.js';
import { LoginCard } from './LoginCard.js';

export function App(): ReactNode {
  const [user, setUser] = useState<UserSession | null>(null);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function init() {
      try {
        const [sessionData, releaseData] = await Promise.all([
          fetchUserSession(),
          fetchLatestRelease('stable'),
        ]);
        if (!active) return;
        setUser(sessionData);
        setRelease(releaseData);
      } catch (err) {
        console.error('Failed to initialize session or release data:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    void init();
    return () => {
      active = false;
    };
  }, []);

  const handleLoginSuccess = async () => {
    try {
      const refreshed = await fetchUserSession();
      setUser(refreshed);
    } catch (err) {
      console.error('Failed to refresh user session after login:', err);
    } finally {
      setLoginOpen(false);
    }
  };

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#08090a',
        color: '#9ca3af',
        fontFamily: 'sans-serif'
      }}>
        <span>Loading JOY Media...</span>
      </div>
    );
  }

  return (
    <>
      {user ? (
        <AccountLanding
          user={user}
          release={release}
          onLogout={() => setUser(null)}
        />
      ) : (
        <LandingHero
          release={release}
          onOpenLogin={() => setLoginOpen(true)}
        />
      )}

      <LoginCard
        isOpen={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSuccess={handleLoginSuccess}
      />
    </>
  );
}
