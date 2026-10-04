import { type ReactNode } from 'react';
import type { ReleaseInfo } from './api.js';

interface LandingHeroProps {
  readonly release: ReleaseInfo | null;
  readonly onOpenLogin: () => void;
}

export function LandingHero({ release, onOpenLogin }: LandingHeroProps): ReactNode {
  return (
    <div className="landing-container">
      {/* Top Navbar */}
      <header className="landing-navbar">
        <div className="landing-brand">
          <img src="/assets/JoyCodeNew_32x32.png" alt="JOY Media" width={28} height={28} />
          <span className="landing-brand-title">JOY Media</span>
          <span className="landing-brand-tag">Windows NLE</span>
        </div>

        <nav className="landing-nav-links">
          <a href="#features">Features</a>
          <a href="#architecture">Architecture</a>
          <a href="#specs">Specifications</a>
          <button type="button" className="landing-nav-login-btn" onClick={onOpenLogin}>
            Sign In / Account
          </button>
        </nav>
      </header>

      {/* Hero Section */}
      <section className="landing-hero-section">
        <div className="landing-hero-badge">
          <span>⚡ Next-Generation Windows Desktop Release · v{release?.version || '1.0.0'}</span>
        </div>

        <h1 className="landing-hero-title">
          100% Offline-First NLE <br />
          <span className="landing-gradient-text">Powered by Local AI Intelligence</span>
        </h1>

        <p className="landing-hero-subtitle">
          Sample-accurate multi-track video editing, living looks, and on-device GPU acceleration.
          Built for creators who demand zero latency, total privacy, and no cloud subscription
          lock-in.
        </p>

        <div className="landing-hero-cta-group">
          <a
            href={release?.downloadUrl || '/releases/joy-media-windows-x64-v1.0.0.zip'}
            className="landing-btn-primary"
            download
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download for Windows (x64)
          </a>

          <button type="button" className="landing-btn-secondary" onClick={onOpenLogin}>
            Manage Account & Devices →
          </button>
        </div>

        <div className="landing-hero-meta">
          <span>Windows 10 / 11 64-bit</span>
          <span className="dot-sep">•</span>
          <span>Installer & Portable Zip</span>
          <span className="dot-sep">•</span>
          <span>SHA-256 Verified</span>
        </div>

        {/* Hero Visual Mockup */}
        <div className="landing-hero-preview">
          <div className="preview-window-bar">
            <div className="preview-dots">
              <span className="p-dot is-red" />
              <span className="p-dot is-yellow" />
              <span className="p-dot is-green" />
            </div>
            <div className="preview-window-title">
              JOY Studio — [Project: 4K_Commercial_Editorial.joy] — WebGL2 GPU Engine
            </div>
          </div>
          <div className="preview-window-body">
            <div className="preview-layout-grid">
              <div className="preview-sidebar">
                <div className="preview-sidebar-item is-active">
                  <span className="sidebar-icon">🎞️</span>
                  <span>Timeline</span>
                </div>
                <div className="preview-sidebar-item">
                  <span className="sidebar-icon">🎨</span>
                  <span>Living Looks</span>
                </div>
                <div className="preview-sidebar-item">
                  <span className="sidebar-icon">📁</span>
                  <span>Local Assets</span>
                </div>
                <div className="preview-sidebar-item">
                  <span className="sidebar-icon">🤖</span>
                  <span>Joy Code Agent</span>
                </div>
                <div className="preview-sidebar-item">
                  <span className="sidebar-icon">⚡</span>
                  <span>GPU Worker</span>
                </div>
              </div>
              <div className="preview-main-content">
                <div className="preview-monitor-box">
                  <div className="preview-aspect-badge">16:9 4K UHD · WebGL2 Hardware GPU</div>
                  <div className="preview-monitor-center">
                    <div className="monitor-reticle" />
                    <span className="monitor-look-tag">Editorial Clean 4K</span>
                  </div>
                  <div className="preview-playhead-time">00:01:24:18</div>
                </div>
                <div className="preview-timeline-tracks">
                  <div className="preview-timeline-ruler">
                    <span>00:00:00</span>
                    <span>00:00:30</span>
                    <span>00:01:00</span>
                    <span>00:01:30</span>
                    <span>00:02:00</span>
                    <div className="timeline-playhead-needle" />
                  </div>
                  <div className="preview-track-row is-v">
                    <span className="track-label">V2</span>
                    <div className="clip-box c-look" style={{ width: '55%', left: '15%' }}>
                      <span className="clip-tag">LOOK</span>
                      <span className="clip-name">Living Look: Editorial Clean (LUT + Glow)</span>
                    </div>
                  </div>
                  <div className="preview-track-row is-v">
                    <span className="track-label">V1</span>
                    <div className="clip-box c-video" style={{ width: '90%', left: '0%' }}>
                      <span className="clip-tag">VIDEO</span>
                      <span className="clip-name">Main_Footage_4K_Raw.mp4</span>
                    </div>
                  </div>
                  <div className="preview-track-row is-a">
                    <span className="track-label">A1</span>
                    <div className="clip-box c-audio" style={{ width: '90%', left: '0%' }}>
                      <span className="clip-tag">AUDIO</span>
                      <span className="clip-name">Voiceover (DeepFilterNet Denoised)</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="landing-features-section">
        <div className="section-header">
          <span className="section-kicker">Desktop Power</span>
          <h2>Engineered for High-Performance Editing</h2>
          <p>Everything runs on your workstation. No streaming stalls, no cloud upload waits.</p>
        </div>

        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">⚡</div>
            <h3>100% Local-First Engine</h3>
            <p>
              Projects persist instantaneously in SQLite WAL with zero-delay OPFS caching. Over
              3,000 sound effects and assets stream from local disk via native{' '}
              <code>joy-asset://</code> protocol.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">🎞️</div>
            <h3>Dual-Lens Pro Timeline</h3>
            <p>
              Dedicated visual (V1–V10) and audio (A1–A4) track isolation. Sample-accurate playhead,
              magnetic ripple editing, and zero-drop WebGL2 hardware GPU preview monitor.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">🧠</div>
            <h3>On-Device AI Acceleration</h3>
            <p>
              Embedded standalone <code>joy-worker.exe</code> executes Real-ESRGAN super-resolution,
              DeepFilterNet real-time audio denoise, and BiRefNet matting directly on your local
              GPU.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">🎨</div>
            <h3>Living Looks Motion System</h3>
            <p>
              6 cinematic look packs (Editorial Clean, Product Precision, Kinetic Type, Quiet
              Documentary, Music Pulse, Persian Editorial) with dynamic typography and color
              palettes.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">🤖</div>
            <h3>Dual AI Agent Studio</h3>
            <p>
              Sign in with a JOY account and active Pro subscription to use Joy Model, or bring your
              own API keys (OpenRouter, OpenAI-compatible) stored securely inside the Windows DPAPI
              encrypted vault.
            </p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">📦</div>
            <h3>Studio Delivery & Verification</h3>
            <p>
              Hardware-accelerated H.264/AAC exports with presets for Reels, Shorts, YouTube 4K, and
              archival masters, verified by cryptographic checksums on completion.
            </p>
          </div>
        </div>
      </section>

      {/* Specifications */}
      <section id="specs" className="landing-specs-section">
        <div className="specs-card">
          <div className="specs-col">
            <h3>Minimum System Requirements</h3>
            <ul>
              <li>
                <strong>OS:</strong> Windows 10 or 11 (64-bit)
              </li>
              <li>
                <strong>CPU:</strong> Intel Core i5 / AMD Ryzen 5 (4+ cores)
              </li>
              <li>
                <strong>RAM:</strong> 8 GB RAM
              </li>
              <li>
                <strong>Disk:</strong> 2 GB free disk space
              </li>
            </ul>
          </div>
          <div className="specs-col">
            <h3>Recommended Workstation</h3>
            <ul>
              <li>
                <strong>OS:</strong> Windows 11 (64-bit)
              </li>
              <li>
                <strong>GPU:</strong> NVIDIA GeForce RTX 2060 or newer (CUDA support)
              </li>
              <li>
                <strong>RAM:</strong> 16 GB+ high-speed RAM
              </li>
              <li>
                <strong>Storage:</strong> Fast NVMe SSD for media scratch cache
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-footer-content">
          <div className="landing-footer-brand">
            <strong>JOY Media</strong> · Desktop Video Editor & Creative AI Studio
          </div>
          <div className="landing-footer-links">
            <button type="button" className="footer-link-btn" onClick={onOpenLogin}>
              Account Portal
            </button>
            <span className="dot-sep">•</span>
            <span>Private Preview</span>
            <span className="dot-sep">•</span>
            <span>© {new Date().getFullYear()} JOY Team</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
