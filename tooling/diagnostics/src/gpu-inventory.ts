/**
 * A read-only GPU inventory for the attended diagnosis (plan section 3.2, session G1, step 1). It runs fixed
 * queries that only read: the OS build, each adapter and its driver, the HAGS registry value, this app's per-app
 * GPU preference, its exploit-protection policy, and the names of running overlay and capture programs. The
 * result passes the redactor and is written to a file outside the repository. It changes no setting, installs
 * nothing, and never reads crash dumps or logs.
 *
 * Run it with: node --experimental-strip-types tooling/diagnostics/src/gpu-inventory.ts --out <file outside the repo>
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { redactFields, type RedactionOptions } from './redact-gpu-report.ts';

/** The only top-level fields a redacted inventory may contain. */
export const INVENTORY_FIELDS = [
  'capturedAt',
  'osBuild',
  'adapters',
  'gpuScheduling',
  'appGpuPreference',
  'exploitProtection',
  'runningOverlays',
] as const;

export type InventoryField = (typeof INVENTORY_FIELDS)[number];

export interface GpuAdapter {
  readonly name: string;
  readonly driverVersion: string;
  readonly vendor: string;
}

export type GpuInventory = {
  readonly capturedAt: string;
  readonly osBuild: string;
  readonly adapters: readonly GpuAdapter[];
  readonly gpuScheduling: string;
  readonly appGpuPreference: string;
  readonly exploitProtection: Readonly<Record<string, string>>;
  readonly runningOverlays: readonly string[];
};

/** Overlay, capture and game-bar programs. Only their process names are recorded. */
const OVERLAY_PROCESSES = [
  'nvsphelper64',
  'GameBar',
  'GameBarFTServer',
  'Discord',
  'obs64',
  'RTSS',
  'RTSSHooksLoader64',
  'MSIAfterburner',
  'steamwebhelper',
  'Overwolf',
];

/** The values Windows writes after "GpuPreference=" under HKCU\Software\Microsoft\DirectX\UserGpuPreferences. */
const GPU_PREFERENCE_NAMES: Readonly<Record<string, string>> = {
  '0': 'system default',
  '1': 'power saving',
  '2': 'high performance',
};

/** Fixed queries. Each one only reads, and assertReadOnlyCommand refuses anything that could change state. */
export const READ_ONLY_COMMANDS = {
  osBuild:
    'Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object Caption, Version | ConvertTo-Json -Compress',
  adapters:
    'Get-CimInstance -ClassName Win32_VideoController | Select-Object Name, DriverVersion | ConvertTo-Json -Compress',
  // The two registry reads may find nothing, and that is an answer. They exit 0 and print nothing in that case.
  gpuScheduling:
    "try { $value = (Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' -ErrorAction Stop).HwSchedMode; if ($null -ne $value) { $value } } catch { }; exit 0",
  appGpuPreference:
    "try { (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences' -ErrorAction Stop).PSObject.Properties | Where-Object { $_.Name -like '*\\joy-media.exe' } | ForEach-Object { $_.Value } | ConvertTo-Json -Compress } catch { }; exit 0",
  exploitProtection:
    'Get-ProcessMitigation -Name joy-media.exe | ConvertTo-Json -Depth 3 -Compress',
  runningProcesses:
    'Get-Process | Select-Object -ExpandProperty ProcessName | ConvertTo-Json -Compress',
} as const;

/** Any cmdlet whose verb can change state. */
const MUTATING_VERB =
  /\b(?:Set|New|Remove|Start|Stop|Invoke|Install|Uninstall|Enable|Disable|Copy|Move|Rename|Clear|Add|Restart|Write|Export|Reset|Register|Unregister|Update|Format|Out|Send|Save|Edit|Suspend|Resume|Import)-[A-Za-z]+/;

/** Refuses a command that could change state: a mutating cmdlet, or output redirected into a file. */
export function assertReadOnlyCommand(command: string): void {
  if (MUTATING_VERB.test(command) || command.includes('>')) {
    throw new Error(`Refusing a command that is not read-only: ${command}`);
  }
}

/** The vendor, from the adapter's marketing name. Anything unrecognised is "Other". */
export function vendorOf(adapterName: string): string {
  if (/nvidia|geforce|quadro/i.test(adapterName)) return 'NVIDIA';
  if (/\bamd\b|radeon/i.test(adapterName)) return 'AMD';
  if (/intel/i.test(adapterName)) return 'Intel';
  return 'Other';
}

/** ConvertTo-Json writes an object for one item, an array for several, and nothing for none. */
function jsonItems(output: string): unknown[] {
  const text = output.trim();
  if (text === '' || text === 'null') return [];
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function records(output: string): Record<string, unknown>[] {
  return jsonItems(output).filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );
}

function strings(output: string): string[] {
  return jsonItems(output).filter((item): item is string => typeof item === 'string');
}

function field(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  return typeof value === 'string' ? value.trim() : '';
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** The OS caption without the "Microsoft" prefix, then the version, for example "Windows 11 Pro 10.0.26300". */
export function parseOsBuild(output: string): string {
  const [os] = records(output);
  if (!os) return '';
  const caption = field(os, 'Caption').replace(/^Microsoft\s+/, '');
  return [caption, field(os, 'Version')].filter((part) => part !== '').join(' ');
}

export function parseAdapters(output: string): GpuAdapter[] {
  return records(output)
    .map((record) => ({
      name: field(record, 'Name'),
      driverVersion: field(record, 'DriverVersion'),
    }))
    .filter((adapter) => adapter.name !== '')
    .map((adapter) => ({ ...adapter, vendor: vendorOf(adapter.name) }));
}

/** The raw HwSchedMode value. Its meaning is left to the reader, and an unset value is said so. */
export function parseGpuScheduling(output: string): string {
  const value = output.trim();
  return value === '' ? 'not set' : `HwSchedMode=${value}`;
}

export function parseAppGpuPreference(output: string): string {
  const [value] = strings(output);
  if (value === undefined) return 'not set';
  const match = /GpuPreference=(\d+)/.exec(value);
  if (!match) return 'unrecognised';
  return GPU_PREFERENCE_NAMES[match[1] ?? ''] ?? 'unrecognised';
}

/** The scalar settings of the mitigation policy, flattened to "Policy.Setting" keys. Lists are dropped. */
export function parseExploitProtection(output: string): Record<string, string> {
  const [policy] = records(output);
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(policy ?? {})) {
    if (isScalar(value)) {
      flat[key] = String(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [setting, inner] of Object.entries(value as Record<string, unknown>)) {
        if (isScalar(inner)) flat[`${key}.${setting}`] = String(inner);
      }
    }
  }
  // Get-ProcessMitigation prints nothing when the image has no per-image overrides, so the system defaults apply.
  if (Object.keys(flat).length === 0) flat.perImagePolicy = 'none set; system defaults apply';
  return flat;
}

/** The overlay programs from the known list that are running. Only their names are returned. */
export function parseRunningOverlays(output: string): string[] {
  const running = new Set(strings(output).map((name) => name.toLowerCase()));
  return OVERLAY_PROCESSES.filter((name) => running.has(name.toLowerCase())).sort();
}

/** Runs every fixed query through `run` and returns the raw, unredacted inventory. */
export function collectGpuInventory(
  run: (command: string) => string,
  capturedAt: Date,
): GpuInventory {
  for (const command of Object.values(READ_ONLY_COMMANDS)) assertReadOnlyCommand(command);
  return {
    capturedAt: capturedAt.toISOString(),
    osBuild: parseOsBuild(run(READ_ONLY_COMMANDS.osBuild)),
    adapters: parseAdapters(run(READ_ONLY_COMMANDS.adapters)),
    gpuScheduling: parseGpuScheduling(run(READ_ONLY_COMMANDS.gpuScheduling)),
    appGpuPreference: parseAppGpuPreference(run(READ_ONLY_COMMANDS.appGpuPreference)),
    exploitProtection: parseExploitProtection(run(READ_ONLY_COMMANDS.exploitProtection)),
    runningOverlays: parseRunningOverlays(run(READ_ONLY_COMMANDS.runningProcesses)),
  };
}

/** Applies the inventory allowlist. The sensitive literals are this PC's account and host names. */
export function redactInventory(
  report: Readonly<Record<string, unknown>>,
  sensitive: readonly string[],
): Partial<Record<InventoryField, unknown>> {
  const options: RedactionOptions = { sensitive: sensitive.filter((value) => value.length > 0) };
  return redactFields(report, options, INVENTORY_FIELDS);
}

/**
 * The rules a path comparison follows. Windows and POSIX differ in their separators and in whether case matters, so
 * a caller can choose either. The script itself uses the host's rules.
 */
interface PathRules {
  readonly sep: string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

/**
 * True when `target` is `repository` itself or sits under it. The comparison works on whole path segments, so a
 * sibling whose name begins with the repository's name (`repo-other` beside `repo`) is outside.
 */
export function isInsideRepository(
  target: string,
  repository: string,
  rules: PathRules = { relative, isAbsolute, sep },
): boolean {
  const path = rules.relative(repository, target);
  if (path === '') return true;
  if (rules.isAbsolute(path)) return false;
  return path !== '..' && !path.startsWith(`..${rules.sep}`);
}

/** Runs one fixed query in Windows PowerShell and returns its standard output. */
export function runPowerShell(command: string): string {
  assertReadOnlyCommand(command);
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
}

function writeInventory(outputPath: string): void {
  // The script runs from tooling/diagnostics/src, three folders below the repository root.
  const repositoryRoot = resolve(dirname(process.argv[1] ?? '.'), '..', '..', '..');
  const target = resolve(outputPath);
  if (isInsideRepository(target, repositoryRoot)) {
    throw new Error(
      'Refusing to write the inventory inside the repository. Choose a folder outside it.',
    );
  }
  const inventory = collectGpuInventory(runPowerShell, new Date());
  const redacted = redactInventory(inventory, [userInfo().username, hostname()]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote the redacted GPU inventory to ${target}\n`);
}

if (basename(process.argv[1] ?? '') === 'gpu-inventory.ts') {
  const flag = process.argv.indexOf('--out');
  const outputPath = flag === -1 ? undefined : process.argv[flag + 1];
  if (outputPath === undefined) {
    process.stderr.write('Usage: gpu-inventory.ts --out <file outside the repository>\n');
    process.exitCode = 2;
  } else {
    writeInventory(outputPath);
  }
}
