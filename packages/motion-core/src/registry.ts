/**
 * MotionRegistry — the runtime registry of all motions (built-in + user).
 * Motions are addressed by id; built-ins are immutable but duplicable.
 */

import type { MotionDescriptor, MotionSource } from './descriptor.js';
import type { MotionSceneDocument } from './scene.js';

export interface MotionRegistryEntry {
  readonly descriptor: MotionDescriptor;
}

export class MotionRegistry {
  readonly #entries = new Map<string, MotionRegistryEntry>();

  register(descriptor: MotionDescriptor): void {
    this.#entries.set(descriptor.id, { descriptor });
  }

  unregister(id: string): boolean {
    const entry = this.#entries.get(id);
    if (entry?.descriptor.source === 'built-in') return false;
    return this.#entries.delete(id);
  }

  get(id: string): MotionDescriptor | undefined {
    return this.#entries.get(id)?.descriptor;
  }

  getAll(): readonly MotionDescriptor[] {
    return [...this.#entries.values()].map((e) => e.descriptor);
  }

  findBySource(source: MotionSource): readonly MotionDescriptor[] {
    return this.getAll().filter((d) => d.source === source);
  }

  search(query: string): readonly MotionDescriptor[] {
    const q = query.toLowerCase();
    return this.getAll().filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q)) ||
        d.category.toLowerCase().includes(q),
    );
  }

  duplicate(id: string, newId: string, newName: string): MotionDescriptor | undefined {
    const original = this.get(id);
    if (original === undefined) return undefined;
    const duplicated: MotionDescriptor = {
      ...original,
      id: newId,
      name: newName,
      source: 'user',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.register(duplicated);
    return duplicated;
  }

  get size(): number {
    return this.#entries.size;
  }
}

export function convertPresetToScene(
  name: string,
  width = 1080,
  height = 1920,
  durationMs = 3000,
): MotionSceneDocument {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    width,
    height,
    durationMs,
    frameRate: 30,
    background: { kind: 'transparent' },
    layers: [],
    variables: [],
    components: [],
    markers: [],
  };
}
