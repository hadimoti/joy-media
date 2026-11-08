// Puts the JOY mark into a Windows executable's icon group, so Explorer, the taskbar and shortcuts show it.
import { readFile, writeFile } from 'node:fs/promises';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

/**
 * Replaces the images of every icon group in the executable with the images of the given .ico file.
 * The executable is rewritten in place; the icon file is only read. Throws if the executable has no icon group.
 */
export async function setExecutableIcon(exePath, icoPath) {
  const exe = NtExecutable.from(await readFile(exePath));
  const res = NtExecutableResource.from(exe);
  const icons = Data.IconFile.from(await readFile(icoPath)).icons.map((item) => item.data);
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length === 0) throw new Error(`No icon group found in ${exePath}`);
  for (const group of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icons);
  }
  res.outputResource(exe);
  await writeFile(exePath, Buffer.from(exe.generate()));
}
