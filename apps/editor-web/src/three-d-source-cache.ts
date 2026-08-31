import type { OpfsDirectoryHandle } from './opfs-asset-cache.js';

export interface ThreeDSourceStore {
  put(sceneId: string, files: readonly File[]): Promise<readonly string[]>;
  get(sourceRef: string): Promise<Blob | undefined>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeName(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
  return encodeURIComponent(base).slice(0, 180) || 'source.bin';
}

export function createThreeDSourceRef(sceneId: string, index: number, name: string): string {
  if (!SAFE_ID.test(sceneId) || !Number.isInteger(index) || index < 0) throw new Error('invalid 3D source reference');
  return `${sceneId}/${index}-${safeName(name)}`;
}

export function sourceRefDisplayName(sourceRef: string): string {
  const encoded = sourceRef.slice(sourceRef.indexOf('/') + 1).replace(/^\d+-/, '');
  try {
    return decodeURIComponent(encoded) || 'source.bin';
  } catch {
    return 'source.bin';
  }
}

export class OpfsThreeDSourceStore implements ThreeDSourceStore {
  constructor(private readonly root: OpfsDirectoryHandle | undefined) {}

  private async sceneDir(sceneId: string, create: boolean): Promise<OpfsDirectoryHandle> {
    if (!SAFE_ID.test(sceneId)) throw new Error('invalid 3D scene ID');
    if (this.root === undefined) throw new Error('OPFS is unavailable in this browser');
    const media = await this.root.getDirectoryHandle('joy-media-assets', { create });
    const models = await media.getDirectoryHandle('joycode-3d', { create });
    return models.getDirectoryHandle(sceneId, { create });
  }

  async put(sceneId: string, files: readonly File[]): Promise<readonly string[]> {
    if (files.length === 0) throw new Error('at least one 3D source file is required');
    const directory = await this.sceneDir(sceneId, true);
    const refs: string[] = [];
    for (const [index, file] of files.entries()) {
      if (file.size <= 0 || file.size > 100 * 1024 * 1024) throw new Error(`3D source ${file.name} is empty or too large`);
      const ref = createThreeDSourceRef(sceneId, index, file.name);
      const writable = await (await directory.getFileHandle(`${index}.bin`, { create: true })).createWritable();
      try { await writable.write(file); } finally { await writable.close(); }
      refs.push(ref);
    }
    return refs;
  }

  async get(sourceRef: string): Promise<Blob | undefined> {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(\d+)-/.exec(sourceRef);
    if (match === null) return undefined;
    try {
      const directory = await this.sceneDir(match[1]!, false);
      return await (await directory.getFileHandle(`${Number(match[2])}.bin`, { create: false })).getFile();
    } catch { return undefined; }
  }
}

export async function openThreeDSourceStore(): Promise<OpfsThreeDSourceStore> {
  const getDirectory = (globalThis.navigator?.storage as (StorageManager & { readonly getDirectory?: () => Promise<OpfsDirectoryHandle> }) | undefined)?.getDirectory;
  return new OpfsThreeDSourceStore(getDirectory === undefined ? undefined : await getDirectory.call(navigator.storage));
}
