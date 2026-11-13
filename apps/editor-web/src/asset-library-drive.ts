/**
 * The asset library folder and the drive it sits on (T-P08).
 *
 * The desktop tells the dialog what kind of drive the folder is on. A library
 * on a removable drive or a network share is not always there: unplug it and
 * the media is missing. The dialog says so, calmly, when it can tell — and
 * stays quiet when it cannot, because a warning about a drive we know nothing
 * about is just noise.
 */
import type { DesktopAssetLibraryDriveType } from './desktop-client.js';

/** What the owner is told when the folder is on a drive that comes and goes. */
export const INTERMITTENT_DRIVE_WARNING =
  'This drive is not always connected. Your media will show as missing when it is unplugged.';

/**
 * Is this a drive that is not always there? "unknown" is not: we could not
 * tell, and the owner is not warned about what we could not find out.
 */
export function isIntermittentAssetLibraryDrive(
  type: DesktopAssetLibraryDriveType | undefined,
): boolean {
  return type === 'removable' || type === 'network';
}
