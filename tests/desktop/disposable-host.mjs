// Destructive installer checks run only where the host is positively identified as disposable.
//
// The owner's PC is a physical machine with no container runner and no lifecycle marker, so every check here
// refuses on it. Finding an existing install is not part of this decision, and neither is any environment flag:
// a missing fact, or a probe that cannot answer, refuses (fail closed).
import { spawnSync } from 'node:child_process';

export const LIFECYCLE_MARKER_PURPOSE = 'joy-media-disposable-test-environment';

const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/u;
const NOT_IDENTIFIED =
  'no CI container runner or Hyper-V disposable guest was positively identified';

// Read-only. Each optional fact is null when its query fails; the hostname is required for the container path.
const PROBE_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '$manufacturer = $null',
  '$model = $null',
  'try { $system = Get-CimInstance -ClassName Win32_ComputerSystem; $manufacturer = [string]$system.Manufacturer; $model = [string]$system.Model } catch { }',
  "$markerPath = Join-Path $env:SystemDrive 'JoyMediaLifecycle\\disposable-environment.json'",
  '$marker = $null',
  'try { if (Test-Path -LiteralPath $markerPath -PathType Leaf) { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } } catch { $marker = $null }',
  '[pscustomobject]@{ hostname = (hostname).Trim().ToLowerInvariant(); manufacturer = $manufacturer; model = $model; marker = $marker } | ConvertTo-Json -Depth 4 -Compress',
].join('\n');

export class DisposableHostRefusal extends Error {
  constructor(reasons) {
    super(`Refusing to run destructive installer checks on this host: ${reasons.join('; ')}.`);
    this.name = 'DisposableHostRefusal';
    this.reasons = reasons;
  }
}

// A CI container runner: GitHub Actions on a self-hosted runner whose container id, recorded by the runner
// entrypoint from Docker's container id, equals the container's hostname. Docker names a container's host by its id.
function isCiContainer(env, facts) {
  return (
    env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'self-hosted' &&
    CONTAINER_ID_PATTERN.test(env.JOY_MEDIA_WINDOWS_CONTAINER_ID ?? '') &&
    facts.hostname === env.JOY_MEDIA_WINDOWS_CONTAINER_ID
  );
}

// A Hyper-V guest: a virtual machine whose disposable-VM provisioning wrote the lifecycle marker.
function isHyperVGuest(facts) {
  return (
    facts.manufacturer === 'Microsoft Corporation' &&
    facts.model === 'Virtual Machine' &&
    facts.marker?.purpose === LIFECYCLE_MARKER_PURPOSE &&
    facts.marker?.kind === 'hyperv-vm'
  );
}

/**
 * Decides from positive evidence only. Returns the environment name when the host is identified, otherwise
 * the reasons it is not. Pure: it reads nothing but its arguments.
 */
export function decideDisposableEnvironment({ platform, env, facts }) {
  if (platform !== 'win32') {
    return {
      allowed: false,
      environment: null,
      reasons: ['the installer checks run only on Windows'],
    };
  }
  if (facts === null || typeof facts !== 'object' || typeof facts.hostname !== 'string') {
    return { allowed: false, environment: null, reasons: ['the environment probe did not answer'] };
  }
  if (isCiContainer(env, facts)) return { allowed: true, environment: 'ci-container', reasons: [] };
  if (isHyperVGuest(facts)) return { allowed: true, environment: 'hyperv-vm', reasons: [] };
  return { allowed: false, environment: null, reasons: [NOT_IDENTIFIED] };
}

/** Reads the host facts through PowerShell. Any failure returns null, which refuses. */
export function probeHostFacts({ run = spawnSync } = {}) {
  const encoded = Buffer.from(PROBE_SCRIPT, 'utf16le').toString('base64');
  const result = run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  return {
    hostname: typeof parsed.hostname === 'string' ? parsed.hostname : null,
    manufacturer: typeof parsed.manufacturer === 'string' ? parsed.manufacturer : null,
    model: typeof parsed.model === 'string' ? parsed.model : null,
    marker: parsed.marker ?? null,
  };
}

function readFacts(probe) {
  try {
    return probe();
  } catch {
    return null;
  }
}

/**
 * Throws DisposableHostRefusal unless the host is positively identified. Returns the environment name.
 * The probe is never run off Windows, and an injected probe lets tests supply any facts they need.
 */
export function assertDisposableHost({
  platform = process.platform,
  env = process.env,
  probe = probeHostFacts,
} = {}) {
  const facts = platform === 'win32' ? readFacts(probe) : null;
  const verdict = decideDisposableEnvironment({ platform, env, facts });
  if (!verdict.allowed) throw new DisposableHostRefusal(verdict.reasons);
  return verdict.environment;
}
