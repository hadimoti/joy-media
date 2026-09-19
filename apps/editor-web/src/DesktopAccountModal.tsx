import { useState, useRef, useEffect, type ReactNode } from 'react';
import { registerDevice, requestOtp, verifyOtp, type MediaAuthMethod } from './media-session.js';
import './desktop-account-modal.css';

interface DesktopAccountModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess?: () => void;
}

export function DesktopAccountModal({
  isOpen,
  onClose,
  onSuccess,
}: DesktopAccountModalProps): ReactNode {
  const [method, setMethod] = useState<MediaAuthMethod>('gmail');
  const [contact, setContact] = useState('');
  const [step, setStep] = useState<'contact' | 'otp'>('contact');
  const [otpDigits, setOtpDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [hint, setHint] = useState<string | undefined>();
  const [successGlow, setSuccessGlow] = useState(false);

  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);
  const contactInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setStep('contact');
      setError(undefined);
      setHint(undefined);
      setSuccessGlow(false);
      setOtpDigits(['', '', '', '', '', '']);
      setTimeout(() => {
        contactInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSendCode = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanContact = contact.trim();
    if (!cleanContact) {
      setError(
        method === 'gmail'
          ? 'Please enter a valid Gmail address'
          : 'Please enter your Telegram handle',
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    setHint(undefined);
    try {
      const msg = await requestOtp(cleanContact, method);
      setHint(msg || `Code sent to ${cleanContact}`);
      setStep('otp');
      setTimeout(() => {
        otpRefs.current[0]?.focus();
      }, 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request verification code');
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

    // Auto-verify when 6 digits are entered
    if (next.every((d) => d.length > 0)) {
      void submitOtp(next.join(''));
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
      void submitOtp(digits.join(''));
    }
  };

  const submitOtp = async (code: string) => {
    if (busy || code.length < 6) return;
    setBusy(true);
    setError(undefined);
    try {
      await verifyOtp(contact.trim(), method, code, window.localStorage);
      void registerDevice(undefined, window.localStorage);
      setSuccessGlow(true);
      setHint('Connected successfully! Workstation registered.');
      setTimeout(() => {
        onSuccess?.();
        onClose();
      }, 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
      setOtpDigits(['', '', '', '', '', '']);
      otpRefs.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="desktop-auth-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className={`desktop-auth-modal-card ${successGlow ? 'is-success' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="desktop-auth-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          &times;
        </button>

        <div className="desktop-auth-modal-header">
          <div className="desktop-auth-modal-badge">JOY Studio Control Plane</div>
          <h2>Connect JOY Account</h2>
          <p>
            Sign in with your account to unlock the built-in <strong>Joy Model (Pro AI)</strong>,
            synchronize subscriptions, and register this workstation.
          </p>
        </div>

        <div className="desktop-auth-method-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={method === 'gmail'}
            className={`desktop-auth-tab ${method === 'gmail' ? 'is-active' : ''}`}
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
            role="tab"
            aria-selected={method === 'telegram'}
            className={`desktop-auth-tab ${method === 'telegram' ? 'is-active' : ''}`}
            onClick={() => {
              setMethod('telegram');
              setStep('contact');
              setError(undefined);
            }}
          >
            Telegram
          </button>
        </div>

        {error && <div className="desktop-auth-alert is-error">{error}</div>}
        {hint && <div className="desktop-auth-alert is-hint">{hint}</div>}

        {step === 'contact' ? (
          <form onSubmit={handleSendCode} className="desktop-auth-form">
            <label className="desktop-auth-label">
              <span>{method === 'gmail' ? 'Gmail Address' : 'Telegram Username or ID'}</span>
              <input
                ref={contactInputRef}
                type={method === 'gmail' ? 'email' : 'text'}
                placeholder={method === 'gmail' ? 'your.name@gmail.com' : 'username'}
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                disabled={busy}
                className="desktop-auth-input"
                autoComplete="email"
                required
              />
            </label>
            <button
              type="submit"
              disabled={busy || !contact.trim()}
              className="desktop-auth-submit-btn"
            >
              {busy ? 'Sending code…' : 'Send Verification Code →'}
            </button>
          </form>
        ) : (
          <div className="desktop-auth-form">
            <label className="desktop-auth-label">
              <span>Enter 6-Digit Code sent to {contact}</span>
              <div className="desktop-auth-otp-row" onPaste={handleOtpPaste}>
                {otpDigits.map((digit, idx) => (
                  <input
                    key={idx}
                    ref={(el) => {
                      otpRefs.current[idx] = el;
                    }}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpChange(idx, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                    disabled={busy}
                    className="desktop-auth-otp-box"
                  />
                ))}
              </div>
            </label>

            <div className="desktop-auth-otp-actions">
              <button
                type="button"
                className="desktop-auth-back-btn"
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
                className="desktop-auth-submit-btn"
                disabled={busy || otpDigits.some((d) => d.length === 0)}
                onClick={() => submitOtp(otpDigits.join(''))}
              >
                {busy ? 'Verifying…' : 'Verify & Connect →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
