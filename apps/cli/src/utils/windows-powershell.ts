/**
 * The Windows PowerShell host, always started by its absolute path. The doctor takes no program location,
 * system root or module path from the environment: a value there could point at a network share, and
 * PowerShell would read from it before any check runs. Windows is installed on C:. On another drive the
 * GPU check reports Unknown, and the local check reports the drive as not checked.
 */
const SYSTEM_ROOT = 'C:\\Windows';
const MODULES = `${SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0\\Modules`;

export const WINDOWS_POWERSHELL = `${SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/**
 * The program and the child environment. Windows ignores case in variable names, so every spelling of
 * PSModulePath is removed before one pinned value is set. The rest of the environment passes through.
 */
export function powershellOptions(source: NodeJS.ProcessEnv = process.env): {
  readonly file: string;
  readonly env: NodeJS.ProcessEnv;
} {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (name.toUpperCase() !== 'PSMODULEPATH') env[name] = value;
  }
  env.PSModulePath = MODULES;
  return { file: WINDOWS_POWERSHELL, env };
}
