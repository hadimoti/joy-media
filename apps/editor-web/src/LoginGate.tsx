import { useEffect, useState, type ReactNode } from 'react';
import { probeJoySession } from './identity.js';
import { requestOtp, verifyOtp, type MediaAuthMethod } from './media-session.js';
import './login-gate.css';

type Step = 'checking' | 'contact' | 'otp' | 'unlocked';

/**
 * Independent JOY Media login (ADR-0017): the editor is always mounted, but
 * blurred and non-interactive until this gate unlocks it. Visual language
 * matches joy-vps's login card; "blurred app in background" is literally the
 * real editor underneath, not a synthetic backdrop.
 */
export function LoginGate({ children }: { readonly children: ReactNode }): ReactNode {
  const [step, setStep] = useState<Step>('checking');
  const [method, setMethod] = useState<MediaAuthMethod>('gmail');
  const [contact, setContact] = useState('');
  const [code, setCode] = useState('');
  const [hint, setHint] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void probeJoySession(window.localStorage).then((state) => {
      setStep(state.kind === 'ready' ? 'unlocked' : 'contact');
    });
  }, []);

  const submitContact = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (contact.trim().length === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const message = await requestOtp(contact.trim(), method);
      setHint(message);
      setStep('otp');
    } catch {
      setError('Could not request a login code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (code.trim().length === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await verifyOtp(contact.trim(), method, code.trim(), window.localStorage);
      setStep('unlocked');
    } catch {
      setError('That code is invalid or has expired.');
    } finally {
      setBusy(false);
    }
  };

  const locked = step !== 'unlocked';

  return (
    <>
      <div className={`login-gate-app${locked ? ' login-gate-locked' : ''}`} aria-hidden={locked}>
        {children}
      </div>
      {locked && step !== 'checking' && (
        <div className="login-gate-scrim">
          <div className="login-gate-card">
            <h2>JOY Media</h2>
            <p className="login-gate-hint" lang="fa">
              برای ورود، ایمیل جیمیل یا آیدی عددی تلگرام مجاز خود را وارد کنید
            </p>
            <div className="login-gate-methods">
              <button
                type="button"
                className={`login-gate-method-btn${method === 'gmail' ? ' active' : ''}`}
                onClick={() => setMethod('gmail')}
                disabled={step === 'otp'}
              >
                Gmail
              </button>
              <button
                type="button"
                className={`login-gate-method-btn${method === 'telegram' ? ' active' : ''}`}
                onClick={() => setMethod('telegram')}
                disabled={step === 'otp'}
              >
                Telegram
              </button>
            </div>
            {error !== undefined && <p className="login-gate-error">{error}</p>}
            {step === 'contact' && (
              <form onSubmit={(event) => void submitContact(event)}>
                <input
                  type={method === 'gmail' ? 'email' : 'text'}
                  placeholder={method === 'gmail' ? 'you@gmail.com' : 'Telegram numeric ID'}
                  value={contact}
                  onChange={(event) => setContact(event.target.value)}
                  autoFocus
                />
                <button type="submit" className="login-gate-submit" disabled={busy}>
                  {busy ? 'Sending…' : 'Send code'}
                </button>
              </form>
            )}
            {step === 'otp' && (
              <form onSubmit={(event) => void submitCode(event)}>
                {hint !== undefined && <p className="login-gate-hint">{hint}</p>}
                <div className="login-gate-otp-boxes">
                  <input
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="••••••"
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                    autoFocus
                  />
                </div>
                <button type="submit" className="login-gate-submit" disabled={busy}>
                  {busy ? 'Verifying…' : 'Verify'}
                </button>
                <button
                  type="button"
                  className="login-gate-link"
                  onClick={() => {
                    setStep('contact');
                    setCode('');
                    setError(undefined);
                  }}
                >
                  Use a different account
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
