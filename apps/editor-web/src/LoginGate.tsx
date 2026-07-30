import { useEffect, useRef, useState, type ReactNode } from 'react';
import { probeJoySession } from './identity.js';
import { requestOtp, setStoredMediaToken, verifyOtp, type MediaAuthMethod } from './media-session.js';
import './login-gate.css';

type Step = 'checking' | 'contact' | 'otp' | 'unlocked';
type Method = MediaAuthMethod | 'token';

const METHOD_CONFIG: Record<Method, { sub: string; placeholder: string; type: string; btn: string }> = {
  gmail: { sub: 'Enter your Gmail address', placeholder: 'your@gmail.com', type: 'email', btn: 'Send Code →' },
  telegram: {
    sub: 'Enter your Telegram numeric ID',
    placeholder: '123456789',
    type: 'text',
    btn: 'Send Code →',
  },
  token: { sub: 'Paste your access token', placeholder: 'paste token here...', type: 'text', btn: 'Login →' },
};

/**
 * Independent JOY Media login (ADR-0017) — a faithful port of joy-vps's
 * shared login card (bot/webapp/shared/login.js), same markup/classes/
 * animations, method switcher (Gmail / Telegram / Token), and OTP-box
 * behavior. The editor is always mounted underneath, blurred and
 * non-interactive until this gate unlocks it. Only intentional difference
 * from joy-vps: this app's own logo instead of joyteam's.
 */
export function LoginGate({ children }: { readonly children: ReactNode }): ReactNode {
  const [step, setStep] = useState<Step>('checking');
  const [method, setMethod] = useState<Method>('gmail');
  const [contact, setContact] = useState('');
  const [hint, setHint] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [successGlow, setSuccessGlow] = useState(false);
  const [failBuzz, setFailBuzz] = useState(false);
  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);
  const otpSubmittingRef = useRef(false);

  useEffect(() => {
    void probeJoySession(window.localStorage).then((state) => {
      setStep(state.kind === 'ready' ? 'unlocked' : 'contact');
    });
  }, []);

  const buzz = (message: string): void => {
    setError(message);
    setFailBuzz(false);
    requestAnimationFrame(() => setFailBuzz(true));
  };

  const unlockAfterSuccess = (): void => {
    setSuccessGlow(true);
    window.setTimeout(() => setStep('unlocked'), 520);
  };

  const submitContact = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const value = contact.trim();
    if (value.length === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    if (method === 'token') {
      try {
        setStoredMediaToken(value, window.localStorage);
        const state = await probeJoySession(window.localStorage);
        if (state.kind === 'ready') {
          unlockAfterSuccess();
        } else {
          buzz('That token is invalid or expired.');
        }
      } catch {
        buzz('That token is invalid or expired.');
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const message = await requestOtp(value, method);
      setHint(message);
      setStep('otp');
    } catch {
      buzz('Could not request a login code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitOtp = async (code: string): Promise<void> => {
    if (otpSubmittingRef.current || method === 'token') return;
    otpSubmittingRef.current = true;
    setError(undefined);
    try {
      await verifyOtp(contact.trim(), method, code, window.localStorage);
      unlockAfterSuccess();
    } catch {
      buzz('That code is invalid or has expired.');
      otpRefs.current.forEach((box) => {
        if (box) box.value = '';
      });
      otpRefs.current[0]?.focus();
      otpSubmittingRef.current = false;
    }
  };

  const onOtpChange = (index: number, raw: string): void => {
    const digits = raw.replace(/\D/g, '').slice(0, 6 - index).split('');
    if (digits.length > 1) {
      digits.forEach((digit, offset) => {
        const target = otpRefs.current[index + offset];
        if (target) target.value = digit;
      });
      const next = otpRefs.current.find((box) => box && box.value === '');
      (next ?? otpRefs.current[5])?.focus();
    } else {
      const box = otpRefs.current[index];
      if (box) box.value = digits[0] ?? '';
      if (digits[0] && otpRefs.current[index + 1]) otpRefs.current[index + 1]?.focus();
    }
    const code = otpRefs.current.map((box) => box?.value ?? '').join('');
    if (code.length === 6) void submitOtp(code);
  };

  const onOtpKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Backspace' && !otpRefs.current[index]?.value && otpRefs.current[index - 1]) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const onOtpPaste = (event: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text');
    const digits = text.replace(/\D/g, '').slice(0, 6).split('');
    if (digits.length === 0) return;
    event.preventDefault();
    otpRefs.current.forEach((box, i) => {
      if (box) box.value = digits[i] ?? '';
    });
    (otpRefs.current[Math.min(digits.length, 6) - 1] ?? otpRefs.current[0])?.focus();
    if (digits.length === 6) void submitOtp(digits.join(''));
  };

  const cfg = METHOD_CONFIG[method];
  const locked = step !== 'unlocked';

  return (
    <>
      <div className={`login-gate-app${locked ? ' login-gate-locked' : ''}`} aria-hidden={locked}>
        {children}
      </div>
      {locked && step !== 'checking' && (
        <div className="login-screen">
          <div
            className={`login-card rotating-glow${successGlow ? ' login-success-glow' : ''}${failBuzz ? ' login-fail-buzz' : ''}`}
            onAnimationEnd={() => setFailBuzz(false)}
          >
            <div className="lcard-logo-wrap">
              <img src="/assets/logo.png" className="login-logo" alt="JOY Media" />
            </div>

            <h1 className="login-title" lang="en" dir="ltr" aria-label="Joy Studio.">
              {Array.from('Joy Studio').map((ch, index) => (
                <span
                  key={`${ch}-${index}`}
                  className="login-title-char"
                  style={{ animationDelay: `${index * 45}ms` }}
                >
                  {ch === ' ' ? '\u00A0' : ch}
                </span>
              ))}
              <span
                className="login-title-char login-title-dot"
                style={{
                  animationDelay: `${'Joy Studio'.length * 45}ms, ${'Joy Studio'.length * 45 + 550}ms`,
                }}
                aria-hidden="true"
              >
                .
              </span>
            </h1>

            <div className="lmethods" data-active={method}>
              <button
                type="button"
                className={`lmethod-btn${method === 'gmail' ? ' active' : ''}`}
                onClick={() => {
                  setMethod('gmail');
                  setError(undefined);
                }}
                disabled={step === 'otp'}
              >
                <img src="/assets/icons-login/gmail-64.png" className="lmethod-icon" alt="Gmail" />
                <span>Gmail</span>
              </button>
              <button
                type="button"
                className={`lmethod-btn${method === 'telegram' ? ' active' : ''}`}
                onClick={() => {
                  setMethod('telegram');
                  setError(undefined);
                }}
                disabled={step === 'otp'}
              >
                <img src="/assets/icons-login/telegram-64.png" className="lmethod-icon" alt="Telegram" />
                <span>Telegram</span>
              </button>
              <button
                type="button"
                className={`lmethod-btn${method === 'token' ? ' active' : ''}`}
                onClick={() => {
                  setMethod('token');
                  setError(undefined);
                }}
                disabled={step === 'otp'}
              >
                <span className="lmethod-icon lmethod-key">🔑</span>
                <span>Token</span>
              </button>
            </div>

            <div className="login-panels">
              {step === 'contact' && (
                <form onSubmit={(event) => void submitContact(event)}>
                  <p className="login-sub">{cfg.sub}</p>
                  <input
                    className="auth-input"
                    type={cfg.type}
                    placeholder={cfg.placeholder}
                    value={contact}
                    onChange={(event) => setContact(event.target.value)}
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus
                  />
                  <button type="submit" className="login-btn" disabled={busy}>
                    <span className="login-btn-gradient">{busy ? 'Sending…' : cfg.btn}</span>
                  </button>
                </form>
              )}
              {step === 'otp' && (
                <div>
                  <p className="login-sub">{hint ?? 'Enter the code we sent you'}</p>
                  <div className="otp-row">
                    {Array.from({ length: 6 }, (_, index) => (
                      <span className="otp-glow-wrap" key={index}>
                        <input
                          ref={(el) => {
                            otpRefs.current[index] = el;
                          }}
                          className="otp-box"
                          maxLength={1}
                          inputMode="numeric"
                          pattern="[0-9]"
                          autoComplete="one-time-code"
                          onChange={(event) => onOtpChange(index, event.target.value)}
                          onKeyDown={(event) => onOtpKeyDown(index, event)}
                          onPaste={onOtpPaste}
                          autoFocus={index === 0}
                        />
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="login-back"
                    onClick={() => {
                      setError(undefined);
                      otpSubmittingRef.current = false;
                      setStep('contact');
                    }}
                  >
                    ← back
                  </button>
                </div>
              )}
            </div>

            {error !== undefined && <p className="login-error">{error}</p>}
          </div>
        </div>
      )}
    </>
  );
}
