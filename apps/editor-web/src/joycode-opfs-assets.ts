/**
 * Private Joy Code agent uploads under OPFS `joy-media-assets/joycode/`.
 * Images and Markdown only; opaque ids; no host paths exposed.
 */

import type { OpfsDirectoryHandle } from './opfs-asset-cache.js';

export const JOYCODE_ASSET_MAX_BYTES = 20 * 1024 * 1024;

export type JoyCodeStoredKind = 'image' | 'markdown';

export interface JoyCodeStoredAssetMeta {
  readonly assetId: string;
  readonly displayName: string;
  readonly kind: JoyCodeStoredKind;
  readonly mimeType: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly createdAt: string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function opaqueId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `jc-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }
  return `jc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function classifyFile(file: File): { kind: JoyCodeStoredKind; mimeType: string } | undefined {
  const name = file.name.toLowerCase();
  if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) {
    return { kind: 'image', mimeType: file.type || 'image/png' };
  }
  if (
    file.type === 'text/markdown' ||
    file.type === 'text/x-markdown' ||
    (file.type === 'text/plain' && name.endsWith('.md')) ||
    name.endsWith('.md')
  ) {
    return { kind: 'markdown', mimeType: file.type || 'text/markdown' };
  }
  return undefined;
}

async function writeJson(
  directory: OpfsDirectoryHandle,
  name: string,
  value: unknown,
): Promise<void> {
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try {
    await writable.write(new Blob([JSON.stringify(value)], { type: 'application/json' }));
  } finally {
    await writable.close();
  }
}

async function readIndex(directory: OpfsDirectoryHandle): Promise<JoyCodeStoredAssetMeta[]> {
  try {
    const file = await (await directory.getFileHandle('index.json', { create: false })).getFile();
    const parsed = JSON.parse(await file.text()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is JoyCodeStoredAssetMeta =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as JoyCodeStoredAssetMeta).assetId === 'string',
    );
  } catch {
    return [];
  }
}

export class JoyCodeOpfsAssetCache {
  constructor(private readonly root: OpfsDirectoryHandle | undefined) {}

  private async joycodeDir(create: boolean): Promise<OpfsDirectoryHandle> {
    if (this.root === undefined) throw new Error('OPFS is unavailable in this browser');
    const media = await this.root.getDirectoryHandle('joy-media-assets', { create });
    return media.getDirectoryHandle('joycode', { create });
  }

  async put(file: File): Promise<JoyCodeStoredAssetMeta> {
    const classified = classifyFile(file);
    if (classified === undefined) {
      throw new Error('Only images and Markdown (.md) files can be attached to Joy Code');
    }
    if (file.size <= 0 || file.size > JOYCODE_ASSET_MAX_BYTES) {
      throw new Error(
        `File must be between 1 byte and ${JOYCODE_ASSET_MAX_BYTES / (1024 * 1024)} MiB`,
      );
    }
    const buffer = await file.arrayBuffer();
    const sha256 = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));
    const assetId = opaqueId();
    const meta: JoyCodeStoredAssetMeta = {
      assetId,
      displayName: file.name.trim() || assetId,
      kind: classified.kind,
      mimeType: classified.mimeType,
      sha256,
      bytes: file.size,
      createdAt: new Date().toISOString(),
    };

    const directory = await this.joycodeDir(true);
    const index = await readIndex(directory);
    const bin = await (
      await directory.getFileHandle(`${assetId}.bin`, { create: true })
    ).createWritable();
    try {
      await bin.write(new Blob([buffer], { type: classified.mimeType }));
    } finally {
      await bin.close();
    }
    await writeJson(directory, 'index.json', [...index, meta]);
    return meta;
  }

  async list(): Promise<readonly JoyCodeStoredAssetMeta[]> {
    if (this.root === undefined) return [];
    try {
      const directory = await this.joycodeDir(false);
      return (await readIndex(directory)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch {
      return [];
    }
  }

  async get(assetId: string): Promise<Blob | undefined> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId)) return undefined;
    if (this.root === undefined) return undefined;
    try {
      const directory = await this.joycodeDir(false);
      const handle = await directory.getFileHandle(`${assetId}.bin`, { create: false });
      return await handle.getFile();
    } catch {
      return undefined;
    }
  }

  async remove(assetId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId)) return;
    if (this.root === undefined) return;
    try {
      const directory = await this.joycodeDir(false);
      try {
        await directory.removeEntry(`${assetId}.bin`);
      } catch {
        /* missing bin */
      }
      const next = (await readIndex(directory)).filter((entry) => entry.assetId !== assetId);
      await writeJson(directory, 'index.json', next);
    } catch {
      /* folder missing */
    }
  }
}

export async function openJoyCodeOpfsAssetCache(): Promise<JoyCodeOpfsAssetCache> {
  const getDirectory = (
    globalThis.navigator?.storage as
      (StorageManager & { readonly getDirectory?: () => Promise<OpfsDirectoryHandle> }) | undefined
  )?.getDirectory;
  return new JoyCodeOpfsAssetCache(
    getDirectory === undefined ? undefined : await getDirectory.call(navigator.storage),
  );
}
