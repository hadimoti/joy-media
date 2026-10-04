import { isIP } from 'node:net';

let loopbackWarningLogged = false;

/** Logs once if the API is local-only but no reverse proxy is trusted. */
export function warnIfLoopbackProxyIsUnconfigured(
  host: string,
  trustedProxyAddresses: readonly string[],
  warn: (message: string) => void = console.warn,
): void {
  if (loopbackWarningLogged || trustedProxyAddresses.length > 0 || !isLoopbackHost(host)) return;
  loopbackWarningLogged = true;
  warn(
    'JOY Media API is listening on loopback with no trusted proxy configured; all clients will share one rate-limit bucket.',
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, '');
  if (normalized === 'localhost') return true;
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  if (isIP(normalized) !== 6) return false;
  try {
    const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
    return canonical === '::1' || canonical === '::ffff:127.0.0.1';
  } catch {
    return false;
  }
}
