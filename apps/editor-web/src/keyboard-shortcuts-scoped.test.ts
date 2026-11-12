// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createScopedKeyTable, type ScopedKeyEvent } from './keyboard-shortcuts.js';

const key = (k: string, target: EventTarget | null = null): ScopedKeyEvent => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  target,
});

describe('scoped key table (focus-based keys)', () => {
  it('the scope wins while it is active, else the global key applies', () => {
    const table = createScopedKeyTable();
    let active = false;
    table.setScope('monitor', () => active);
    const run = vi.fn();
    table.register({ scope: 'monitor', match: (event) => event.key === 'ArrowLeft', run });
    expect(table.dispatch(key('ArrowLeft'))).toBe(false);
    active = true;
    expect(table.dispatch(key('ArrowLeft'))).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(table.dispatch(key('ArrowRight'))).toBe(false);
  });

  it('skips text fields unless the binding asks for them', () => {
    const table = createScopedKeyTable();
    table.setScope('monitor', () => true);
    const plain = vi.fn();
    table.register({ scope: 'monitor', match: () => true, run: plain });
    const input = document.createElement('input');
    expect(table.dispatch(key('x', input))).toBe(false);
    const fieldKey = vi.fn();
    table.register({ scope: 'monitor', match: () => true, run: fieldKey, inTextFields: true });
    expect(table.dispatch(key('x', input))).toBe(true);
    expect(fieldKey).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
  });

  it('removing a binding or a scope stops it', () => {
    const table = createScopedKeyTable();
    const removeScope = table.setScope('monitor', () => true);
    const run = vi.fn();
    const remove = table.register({ scope: 'monitor', match: () => true, run });
    remove();
    expect(table.dispatch(key('a'))).toBe(false);
    table.register({ scope: 'monitor', match: () => true, run });
    removeScope();
    expect(table.dispatch(key('a'))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
