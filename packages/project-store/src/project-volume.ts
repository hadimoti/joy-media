import { execFile, execFileSync } from 'node:child_process';

/**
 * Whether a folder's real place is on an NTFS volume that is verified. Only NTFS is verified. FAT, exFAT, SMB, ReFS
 * and every other file system are not, until real-volume tests are done (owner decision, 11 Nov 2026). A fixed or
 * removable local volume counts. A network drive is refused by its drive type, and a UNC path names no local volume.
 *
 * Node cannot read the file system of a Windows volume: its statfs reports type 0 there. So on Windows the local volume
 * that holds the path is looked up in Windows' volume list, by the longest mount point the path starts with. The answer
 * is kept by the volume's device number, which a file identity also carries (the volume serial on Windows). A verified
 * answer is kept for a minute, and a refused one for five seconds, so a transient failure is asked again soon.
 * Other platforms have no such rule and count as verified.
 *
 * Condition (q), 12 Nov 2026 (lane B): the whole check runs in the project-folder worker thread, never in the main
 * process or the renderer. Inside the worker, `warmVolumeAnswer` asks Windows without blocking (a child process the
 * thread waits for asynchronously) before each claim, so the check inside the claim finds the answer kept and asks
 * nothing. Only a place on another volume, such as a recorded original on another drive, is still asked inline.
 *
 * 12 Nov 2026 (lane B, real-volume test on the owner's PC): a share reached by a network path reports the volume serial
 * of the disk behind it, so `\\localhost\C$\...` had the same device number as `C:\` and was accepted from the answer
 * kept for `C:\`. A network path now has answers of its own, so a kept local answer never decides it, and the reverse.
 */

const VERIFIED_MS = 60_000;
const REFUSED_MS = 5_000;

/** What Windows said about one volume: whether it is verified, and the drive line it wrote for it. */
interface VolumeAnswer {
  readonly verified: boolean;
  /**
   * The `DriveType|FileSystem` line Windows wrote for the volume. An empty string means Windows wrote no local volume
   * for the path. Undefined means the question could not be asked at all.
   */
  readonly found: string | undefined;
}

const answers = new Map<string, VolumeAnswer & { readonly at: number }>();

/**
 * Whether a real path reaches its folder over the network: `\\server\share\...` or `\\?\UNC\server\share\...`.
 * A volume name (`\\?\Volume{...}\`) and a device path (`\\.\...`) are local.
 */
export function isNetworkPath(realPlace: string): boolean {
  if (/^\\\\[?.]\\UNC\\/i.test(realPlace)) return true;
  return realPlace.startsWith('\\\\') && !/^\\\\[?.]\\/.test(realPlace);
}

/** The key an answer is kept by: the device number, kept apart for network paths (see the header). */
function answerKey(realPlace: string, volumeKey: bigint): string {
  return isNetworkPath(realPlace) ? `network:${volumeKey}` : volumeKey.toString();
}

/** Questions to Windows still in flight, by volume, so two warms of one volume ask once. */
const warming = new Map<string, Promise<void>>();

/** Drops every kept answer, so that a test asks Windows again. The app itself never needs this. */
export function forgetVolumeAnswers(): void {
  answers.clear();
  warming.clear();
}

function isFresh(known: { readonly verified: boolean; readonly at: number }, now: number): boolean {
  return now - known.at < (known.verified ? VERIFIED_MS : REFUSED_MS);
}

/** Keeps an answer for a volume as if Windows had been asked at `at`. Only the tests use this. */
export function keepVolumeAnswerForTests(
  volumeKey: bigint,
  answer: { readonly verified: boolean; readonly found: string | undefined },
  at: number,
): void {
  answers.set(volumeKey.toString(), { ...answer, at });
}

/**
 * `volumeKey` is the device number that Node reports for the path. It keys the answer, so another volume, or the same
 * drive letter after a disk swap, is asked again.
 */
export function isVerifiedNtfsVolume(realPlace: string, volumeKey: bigint): boolean {
  if (process.platform !== 'win32') return true;
  const key = answerKey(realPlace, volumeKey);
  const now = Date.now();
  const known = answers.get(key);
  if (known !== undefined && isFresh(known, now)) {
    return known.verified;
  }
  const answer = askWindows(realPlace);
  answers.set(key, { ...answer, at: now });
  return answer.verified;
}

/**
 * Asks Windows about the volume that holds `realPlace` without blocking the thread: PowerShell runs as a child process,
 * and the answer is kept as `isVerifiedNtfsVolume` keeps it. Nothing is asked when a fresh answer is kept, or while the
 * same volume is being asked already. It never rejects: a failed question is kept as refused, like the inline check.
 */
export function warmVolumeAnswer(realPlace: string, volumeKey: bigint): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  const key = answerKey(realPlace, volumeKey);
  const known = answers.get(key);
  if (known !== undefined && isFresh(known, Date.now())) return Promise.resolve();
  const inFlight = warming.get(key);
  if (inFlight !== undefined) return inFlight;
  const started = askWindowsAsync(realPlace).then((answer) => {
    if (warming.get(key) === started) answers.set(key, { ...answer, at: Date.now() });
    warming.delete(key);
  });
  warming.set(key, started);
  return started;
}

/** A volume in words for the owner: its kind of drive, and its file system. */
export interface VolumeDescription {
  readonly drive: string;
  readonly fileSystem: string;
}

/**
 * The drive and file system Windows last reported for the volume with this device number, for the owner's message.
 * Undefined when no answer is kept for it, or when the kept answer is too old to show. A verified answer is shown for a
 * minute, and a refused one for five seconds, the same as the check itself. `place` is the folder's path, so a
 * folder reached over the network is described by the answer kept for network paths.
 */
export function describeVolumeAnswer(volumeKey: bigint, place = ''): VolumeDescription | undefined {
  const known = answers.get(answerKey(place, volumeKey));
  if (known === undefined || Date.now() - known.at >= (known.verified ? VERIFIED_MS : REFUSED_MS)) {
    return undefined;
  }
  return describeFound(known.found);
}

const DRIVE_KIND_WORDS: Readonly<Record<string, string>> = {
  '2': 'removable drive',
  '3': 'fixed drive',
  '4': 'network drive',
  '5': 'CD or DVD drive',
};

/** Turns a `DriveType|FileSystem` line into words. `undefined` means the question was not answered. */
export function describeFound(found: string | undefined): VolumeDescription {
  if (found === undefined) return { drive: 'drive not checked', fileSystem: 'unknown' };
  if (found === '') return { drive: 'no local drive', fileSystem: 'none' };
  const [type = '', fileSystem = ''] = found.split('|');
  const fileSystemName = fileSystem.trim();
  return {
    drive: DRIVE_KIND_WORDS[type.trim()] ?? 'drive of another kind',
    fileSystem: fileSystemName === '' ? 'no file system' : fileSystemName,
  };
}

/**
 * The path in the form Windows uses in its volume list. A drive path loses its `\\?\` prefix, and a UNC path becomes
 * `\\server\share`. A volume name with no drive letter keeps its prefix, because the list writes it that way too. The
 * path ends with a backslash, so a mount folder itself (`C:\Mount`) names its own volume (`C:\Mount\`).
 */
export function volumeListPath(realPlace: string): string {
  const extendedUnc = '\\\\?\\UNC\\';
  let plain = realPlace;
  if (plain.startsWith(extendedUnc)) {
    plain = '\\\\' + plain.slice(extendedUnc.length);
  } else if (/^\\\\\?\\[A-Za-z]:\\/.test(plain)) {
    plain = plain.slice(4);
  }
  return plain.endsWith('\\') ? plain : plain + '\\';
}

/**
 * The path travels in an environment variable, never in the script text. The script takes the local volume whose mount
 * point is the longest one the path starts with, and prints its drive type and file system.
 */
const SCRIPT = [
  '$p = $env:PROJECT_PATH',
  '$v = Get-CimInstance -ClassName Win32_Volume | Where-Object { $_.Name -and $p.StartsWith($_.Name, [System.StringComparison]::OrdinalIgnoreCase) } | Sort-Object -Property @{ Expression = { $_.Name.Length }; Descending = $true } | Select-Object -First 1',
  'if ($v) { "$($v.DriveType)|$($v.FileSystem)" }',
].join('; ');

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', SCRIPT];

function askOptions(realPlace: string) {
  return {
    env: { ...process.env, PROJECT_PATH: volumeListPath(realPlace) },
    timeout: 10_000,
    windowsHide: true,
  };
}

function answerFrom(output: Buffer): VolumeAnswer {
  const text = decodeAnswer(output);
  return { verified: isNtfsAnswer(text), found: firstVolumeLine(text) ?? '' };
}

function askWindows(realPlace: string): VolumeAnswer {
  try {
    return answerFrom(execFileSync('powershell.exe', POWERSHELL_ARGS, askOptions(realPlace)));
  } catch {
    return { verified: false, found: undefined };
  }
}

function askWindowsAsync(realPlace: string): Promise<VolumeAnswer> {
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        POWERSHELL_ARGS,
        { ...askOptions(realPlace), encoding: 'buffer' },
        (error, stdout) => {
          resolve(error ? { verified: false, found: undefined } : answerFrom(stdout));
        },
      );
    } catch {
      resolve({ verified: false, found: undefined });
    }
  });
}

/** Reads the answer whether PowerShell wrote UTF-16 or single-byte text, and drops a byte order mark. */
export function decodeAnswer(output: Buffer): string {
  const text = output.includes(0) ? output.toString('utf16le') : output.toString('utf8');
  const byteOrderMark = 0xfeff;
  return text.charCodeAt(0) === byteOrderMark ? text.slice(1) : text;
}

/** The first `DriveType|FileSystem` line in PowerShell's answer, or undefined when there is none. */
export function firstVolumeLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^\d+\|/.test(line));
}

/** True when a line names a local volume (drive type 2 removable or 3 fixed) with the NTFS file system. */
export function isNtfsAnswer(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const answer = line.trim();
    return answer === '2|NTFS' || answer === '3|NTFS';
  });
}
