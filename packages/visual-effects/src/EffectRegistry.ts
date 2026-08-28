import type {
  EffectDescriptor,
  EffectParamDescriptor,
  EffectParamType,
  EffectRegistry,
  EffectRegistryEntry,
} from './types.js';

function validateParamDescriptor(desc: EffectParamDescriptor): void {
  if (!desc.key || typeof desc.key !== 'string') {
    throw new Error(`EffectParamDescriptor.key must be a non-empty string`);
  }
  if (!desc.label || typeof desc.label !== 'string') {
    throw new Error(`EffectParamDescriptor.label must be a non-empty string`);
  }
  const validTypes: EffectParamType[] = ['number', 'boolean', 'color', 'vector2', 'enum'];
  if (!validTypes.includes(desc.type)) {
    throw new Error(`EffectParamDescriptor.type must be one of ${validTypes.join(', ')}`);
  }
  if (desc.type === 'enum' && (!desc.options || desc.options.length === 0)) {
    throw new Error(`enum type requires non-empty options`);
  }
  if (desc.type === 'enum' && desc.options) {
    const values = desc.options.map((o) => o.value);
    if (!values.includes(desc.defaultValue as string | number)) {
      throw new Error(`enum default value "${String(desc.defaultValue)}" not present in options`);
    }
  }
  if (desc.type === 'number') {
    if (desc.min !== undefined && desc.max !== undefined && desc.min > desc.max) {
      throw new Error(`EffectParamDescriptor.min (${desc.min}) > max (${desc.max})`);
    }
    if (desc.defaultValue !== undefined && typeof desc.defaultValue !== 'number') {
      throw new Error(`number type requires number defaultValue`);
    }
  }
  if (desc.type === 'boolean' && typeof desc.defaultValue !== 'boolean') {
    throw new Error(`boolean type requires boolean defaultValue`);
  }
  if (desc.type === 'color' && typeof desc.defaultValue !== 'string') {
    throw new Error(`color type requires string defaultValue`);
  }
  if (desc.type === 'vector2' && !Array.isArray(desc.defaultValue)) {
    throw new Error(`vector2 type requires array defaultValue`);
  }
}

function validateDescriptor(descriptor: EffectDescriptor): void {
  if (!descriptor.id || typeof descriptor.id !== 'string') {
    throw new Error(`EffectDescriptor.id must be a non-empty string`);
  }
  if (!descriptor.label || typeof descriptor.label !== 'string') {
    throw new Error(`EffectDescriptor.label must be a non-empty string`);
  }
  const validCategories: string[] = ['color', 'blur', 'distort', 'artistic', 'depth', 'stylize'];
  if (!validCategories.includes(descriptor.category)) {
    throw new Error(`EffectDescriptor.category must be one of ${validCategories.join(', ')}`);
  }
  if (!descriptor.backend) {
    throw new Error(`EffectDescriptor.backend is required`);
  }
  if (!descriptor.params) {
    throw new Error(`EffectDescriptor.params is required`);
  }
  const keys = new Set<string>();
  for (const param of descriptor.params) {
    if (keys.has(param.key)) {
      throw new Error(`Duplicate parameter key "${param.key}" in effect "${descriptor.id}"`);
    }
    keys.add(param.key);
    validateParamDescriptor(param);
  }
  const validCosts: string[] = ['low', 'medium', 'high'];
  if (!validCosts.includes(descriptor.cost)) {
    throw new Error(`EffectDescriptor.cost must be one of ${validCosts.join(', ')}`);
  }
}

export class EffectRegistryImpl implements EffectRegistry {
  readonly #effects = new Map<string, EffectRegistryEntry>();

  registerEffect(descriptor: EffectDescriptor, factory?: EffectRegistryEntry['factory']): void {
    validateDescriptor(descriptor);
    if (this.#effects.has(descriptor.id)) {
      throw new Error(`Effect "${descriptor.id}" is already registered`);
    }
    this.#effects.set(descriptor.id, {
      descriptor,
      ...(factory !== undefined ? { factory } : {}),
    });
  }

  getEffect(id: string): EffectDescriptor | undefined {
    return this.#effects.get(id)?.descriptor;
  }

  hasEffect(id: string): boolean {
    return this.#effects.has(id);
  }

  listEffects(): readonly EffectDescriptor[] {
    return Array.from(this.#effects.values()).map((e) => e.descriptor);
  }

  getByCategory(category: string): readonly EffectDescriptor[] {
    return this.listEffects().filter((e) => e.category === category);
  }

  searchEffects(query: string): readonly EffectDescriptor[] {
    const q = query.toLowerCase();
    return this.listEffects().filter(
      (e) =>
        e.label.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
}

export const effectRegistry = new EffectRegistryImpl();

export function registerEffect(
  descriptor: EffectDescriptor,
  factory?: EffectRegistryEntry['factory'],
): void {
  effectRegistry.registerEffect(descriptor, factory);
}

export function getEffect(id: string): EffectDescriptor | undefined {
  return effectRegistry.getEffect(id);
}

export function hasEffect(id: string): boolean {
  return effectRegistry.hasEffect(id);
}

export function listEffects(): readonly EffectDescriptor[] {
  return effectRegistry.listEffects();
}

export function getByCategory(category: string): readonly EffectDescriptor[] {
  return effectRegistry.getByCategory(category);
}

export function searchEffects(query: string): readonly EffectDescriptor[] {
  return effectRegistry.searchEffects(query);
}
