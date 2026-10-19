import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Build a Windows CLI child environment without inheriting the caller's PATH or credentials. */
export function safeInstalledCliEnvironment({ stateDirectory, systemRoot, executablePaths }) {
  if (!isAbsolute(stateDirectory)) throw new Error('Acceptance state directory must be absolute.');
  if (!isAbsolute(systemRoot)) throw new Error('Windows system root must be absolute.');
  if (!Array.isArray(executablePaths) || executablePaths.length === 0) {
    throw new Error('At least one absolute media executable path is required.');
  }
  if (executablePaths.some((executablePath) => !isAbsolute(executablePath))) {
    throw new Error('Media executable paths must be absolute.');
  }

  const profile = join(stateDirectory, 'profile');
  const appData = join(profile, 'AppData', 'Roaming');
  const localAppData = join(profile, 'AppData', 'Local');
  const temporary = join(stateDirectory, 'temp');
  const dataDirectory = join(stateDirectory, 'data');
  const system32 = join(systemRoot, 'System32');
  const pathEntries = [system32, ...executablePaths.map(dirname)];
  const uniquePathEntries = [
    ...new Map(pathEntries.map((entry) => [entry.toLowerCase(), entry])).values(),
  ];

  for (const directory of [appData, localAppData, temporary, dataDirectory]) {
    mkdirSync(directory, { recursive: true });
  }

  return {
    PATH: uniquePathEntries.join(';'),
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    COMSPEC: join(system32, 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temporary,
    TMP: temporary,
    NODE_ENV: 'production',
    JOY_MEDIA_SQLITE_PATH: join(dataDirectory, 'joy-media.sqlite3'),
  };
}
