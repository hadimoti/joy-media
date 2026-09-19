import { useState, useRef, useEffect, type ReactNode } from 'react';
import { requestOtp, verifyOtp } from './api.js';

interface LoginCardProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
}

export function LoginCard({ isOpen, onClose, onSuccess }: LoginCardProps): ReactNode {
  const [method, setMethod] = useState<'gmail' | 'telegram'>('gmail');
  const [contact, setContact] = useState('');
  const [step, setStep] = useState<'contact' | 'otp'>('contact');
  const [otpDigits, setOtpDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [hint, setHint] = useState<string | undefined>();
  const [glow, setGlow] = useState(false);

  const contactRef = useRef<HTMLInputElement | null>(null);
  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (isOpen) {
      setStep('contact');
      setError(undefined);
      setHint(undefined);
      setGlow(false);
      setOtpDigits(['', '', '', '', '', '']);
      setTimeout(() => contactRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = contact.trim();
    if (!clean) {
      setError(method === 'gmail' ? 'Enter a valid Gmail address' : 'Enter your Telegram username');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const msg = await requestOtp(clean, method);
      setHint(msg || `Code sent to ${clean}`);
      setStep('otp');
      setTimeout(() => otpRefs.current[0]?.focus(), 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code');
    } finally {
      setBusy(false);
    }
  };

  const handleOtpChange = (index: number, val: string) => {
    const char = val.slice(-1);
    const next = [...otpDigits];
    next[index] = char;
    setOtpDigits(next);
    setError(undefined);

    if (char && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }

    if (next.every((d) => d.length > 0)) {
      void submitCode(next.join(''));
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').trim().replace(/\D/g, '');
    if (pasted.length >= 6) {
      const digits = pasted.slice(0, 6).split('');
      setOtpDigits(digits);
      otpRefs.current[5]?.focus();
      void submitCode(digits.join(''));
    }
  };

  const submitCode = async (code: string) => {
    if (busy || code.length < 6) return;
    setBusy(true);
    setError(undefined);
    try {
      await verifyOtp(contact.trim(), method, code);
      setGlow(true);
      setHint('Signed in successfully!');
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code');
      setOtpDigits(['', '', '', '', '', '']);
      otpRefs.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className={`login-modal-box ${glow ? 'is-success' : ''}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="login-modal-close" onClick={onClose} aria-label="Close dialog">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="login-modal-header">
          <div className="login-brand-badge">JOY Media Account</div>
          <h2>Sign In to JOY Studio</h2>
          <p>Sign in with your Gmail or Telegram to manage your subscription, devices, and downloads.</p>
        </div>

        <div className="login-tabs">
          <button
            type="button"
            className={`login-tab ${method === 'gmail' ? 'is-active' : ''}`}
            onClick={() => {
              setMethod('gmail');
              setStep('contact');
              setError(undefined);
            }}
          >
            Gmail OTP
          </button>
          <button
            type="button"
            className={`login-tab ${method === 'telegram' ? 'is-active' : ''}`}
            onClick={() => {
              setMethod('telegram');
              setStep('contact');
              setError(undefined);
            }}
          >
            Telegram
          </button>
        </div>

        {error && <div className="login-alert is-error">{error}</div>}
        {hint && <div className="login-alert is-hint">{hint}</div>}

        {step === 'contact' ? (
          <form onSubmit={handleSendCode} className="login-form">
            <label className="login-field">
              <span>{method === 'gmail' ? 'Gmail Address' : 'Telegram Handle or ID'}</span>
              <input
                ref={contactRef}
                type={method === 'gmail' ? 'email' : 'text'}
                placeholder={method === 'gmail' ? 'your.email@gmail.com' : '@username'}
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                disabled={busy}
                className="login-input"
                autoComplete="email"
                required
              />
            </label>
            <button type="submit" disabled={busy || !contact.trim()} className="login-btn-primary">
              {busy ? 'Sending OTP…' : 'Send Verification Code →'}
            </button>
          </form>
        ) : (
          <div className="login-form">
            <label className="login-field">
              <span>Enter 6-Digit Code sent to {contact}</span>
              <div className="login-otp-row" onPaste={handleOtpPaste}>
                {otpDigits.map((d, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      otpRefs.current[i] = el;
                    }}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={1}
                    value={d}
                    onChange={(e) => handleOtpChange(i, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(i, e)}
                    disabled={busy}
                    className="login-otp-box"
                  />
                ))}
              </div>
            </label>
            <div className="login-actions-row">
              <button
                type="button"
                className="login-btn-back"
                onClick={() => {
                  setStep('contact');
                  setError(undefined);
                }}
                disabled={busy}
              >
                ← Back
              </button>
              <button
                type="button"
                className="login-btn-primary"
                disabled={busy || otpDigits.some((d) => d.length === 0)}
                onClick={() => submitCode(otpDigits.join(''))}
              >
                {busy ? 'Verifying…' : 'Verify & Sign In →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
