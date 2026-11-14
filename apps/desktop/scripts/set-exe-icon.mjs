// Puts the JOY mark into a Windows executable's icon group, so Explorer, the taskbar and shortcuts show it.
// Also sets the executable's version resource (product name, description, versions), so its Properties
// dialog shows JOY Media and the app version instead of the Electron build's details.
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

/**
 * Sets the version resource of a Windows executable in place: the strings Explorer and the Properties
 * dialog show (ProductName, FileDescription, CompanyName, InternalName, OriginalFilename) and the
 * FileVersion and ProductVersion numbers. `version` must be `major.minor.patch`; FileVersion gets a
 * fourth part of 0. Throws if the executable has no version resource to edit.
 */
export async function setExecutableVersionInfo(
  exePath,
  { version, productName, fileDescription, companyName, internalName, originalFilename },
) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Version must look like 1.2.3, got: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  const exe = NtExecutable.from(await readFile(exePath));
  const res = NtExecutableResource.from(exe);
  const infos = Resource.VersionInfo.fromEntries(res.entries);
  if (infos.length === 0) throw new Error(`No version resource found in ${exePath}`);
  for (const info of infos) {
    const languages = info.getAllLanguagesForStringValues();
    const targets = languages.length > 0 ? languages : [{ lang: 1033, codepage: 1200 }];
    for (const language of targets) {
      info.setStringValues(language, {
        ProductName: productName,
        FileDescription: fileDescription,
        CompanyName: companyName,
        InternalName: internalName,
        OriginalFilename: originalFilename,
        ProductVersion: version,
        FileVersion: `${version}.0`,
      });
    }
    info.setFileVersion(major, minor, patch, 0);
    info.setProductVersion(major, minor, patch, 0);
    info.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  await writeFile(exePath, Buffer.from(exe.generate()));
}
