import { useState, useEffect, type ReactNode } from 'react';
import { fetchLatestRelease, type ReleaseInfo } from './api.js';
import { LandingHero } from './LandingHero.js';

export function App(): ReactNode {
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function init() {
      try {
        const releaseData = await fetchLatestRelease('stable');
        if (!active) return;
        setRelease(releaseData);
      } catch (err) {
        console.error('Failed to load release data:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    void init();
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#08090a',
          color: '#9ca3af',
          fontFamily: 'sans-serif',
        }}
      >
        <span>Loading JOY Media...</span>
      </div>
    );
  }

  return <LandingHero release={release} />;
}
