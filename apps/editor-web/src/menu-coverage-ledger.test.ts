import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_MENU_GROUPS, type AppMenuItem } from './app-menu.js';
import { SHORTCUT_ACTIONS } from './keyboard-shortcuts.js';

/**
 * L6 coverage ledger. Every enabled menu item and every keyboard shortcut action must have an entry
 * in tests/desktop/menu-coverage-ledger.json. A claim that an item is exercised or reachable names a
 * packaged spec, and that spec must contain the evidence text. Open items stay visible; strict
 * release mode (JOY_MEDIA_L6_RELEASE=1) fails while any item is open.
 */

type Status = 'exercised' | 'reachable' | 'open';

interface LedgerClaim {
  readonly status: Status;
  readonly spec?: string;
  readonly evidence?: string;
  readonly note: string;
}

interface Ledger {
  readonly menu: readonly (LedgerClaim & { readonly id: string })[];
  readonly menuPrefixes: readonly (LedgerClaim & { readonly prefix: string })[];
  readonly shortcut: readonly (LedgerClaim & { readonly action: string })[];
}

const ledger = JSON.parse(
  readFileSync(
    new URL('../../../tests/desktop/menu-coverage-ledger.json', import.meta.url),
    'utf8',
  ),
) as Ledger;
const packagedSpecs = new URL('../../../tests/desktop/', import.meta.url);

const isGeneratedPanel = (id: string): boolean =>
  id.startsWith('view.panel.') || id.startsWith('window.panel.');

const enabledItems: readonly AppMenuItem[] = APP_MENU_GROUPS.flatMap((group) => group.items).filter(
  (item) => item.disabled !== true,
);
const staticMenuIds = enabledItems
  .map((item) => item.id as string)
  .filter((id) => !isGeneratedPanel(id));
const generatedMenuIds = enabledItems.map((item) => item.id as string).filter(isGeneratedPanel);

/** Entries whose name is not in `known`. An empty result means the ledger matches the source. */
function unknownNames(names: readonly string[], known: readonly string[]): string[] {
  return names.filter((name) => !known.includes(name));
}

function openItems(): string[] {
  return [
    ...ledger.menu.filter((entry) => entry.status === 'open').map((entry) => entry.id),
    ...ledger.menuPrefixes
      .filter((entry) => entry.status === 'open')
      .map((entry) => `${entry.prefix}*`),
    ...ledger.shortcut
      .filter((entry) => entry.status === 'open')
      .map((entry) => `shortcut ${entry.action}`),
  ];
}

describe('menu and keyboard coverage ledger (L6)', () => {
  it('has a ledger entry for every enabled menu item', () => {
    const listed = ledger.menu.map((entry) => entry.id);
    expect(staticMenuIds.filter((id) => !listed.includes(id))).toEqual([]);
  });

  it('has no ledger entry for a menu item that no longer exists', () => {
    const listed = ledger.menu.map((entry) => entry.id);
    expect(unknownNames(listed, staticMenuIds)).toEqual([]);
  });

  it('covers every generated panel item with a prefix entry', () => {
    const prefixes = ledger.menuPrefixes.map((entry) => entry.prefix);
    const uncovered = generatedMenuIds.filter(
      (id) => !prefixes.some((prefix) => id.startsWith(prefix)),
    );
    expect(uncovered).toEqual([]);
  });

  it('has a ledger entry for every keyboard shortcut action, and no stale entry', () => {
    const listed = ledger.shortcut.map((entry) => entry.action);
    const actions: readonly string[] = SHORTCUT_ACTIONS;
    expect(actions.filter((action) => !listed.includes(action))).toEqual([]);
    expect(unknownNames(listed, actions)).toEqual([]);
  });

  it('names a packaged spec that contains the evidence for every exercised or reachable item', () => {
    const claims = [...ledger.menu, ...ledger.menuPrefixes, ...ledger.shortcut].filter(
      (entry) => entry.status !== 'open',
    );
    for (const claim of claims) {
      const label =
        'id' in claim ? claim.id : 'prefix' in claim ? claim.prefix : `shortcut ${claim.action}`;
      expect(claim.spec, `${label} names no spec`).toBeDefined();
      expect(claim.evidence, `${label} has no evidence`).toBeDefined();
      const specPath = new URL(claim.spec as string, packagedSpecs);
      expect(existsSync(specPath), `${label}: ${claim.spec} does not exist`).toBe(true);
      expect(readFileSync(specPath, 'utf8'), `${label}: evidence not in ${claim.spec}`).toContain(
        claim.evidence as string,
      );
    }
  });

  it('gives every open item a reason', () => {
    const open = [...ledger.menu, ...ledger.menuPrefixes, ...ledger.shortcut].filter(
      (entry) => entry.status === 'open',
    );
    for (const entry of open) expect(entry.note.trim().length).toBeGreaterThan(0);
  });

  it('lists the open items, and fails them in strict release mode', () => {
    const open = openItems();
    console.info(`L6 open coverage items (${open.length}): ${open.join(', ')}`);
    if (process.env['JOY_MEDIA_L6_RELEASE'] === '1') {
      expect(open).toEqual([]);
    }
  });

  it('would flag a stale entry (negative control on the comparison)', () => {
    expect(unknownNames(['file.account', 'file.removed-item'], staticMenuIds)).toEqual([
      'file.removed-item',
    ]);
  });
});
