import { describe, expect, it } from 'vitest';
import { APP_MENU_GROUPS } from './app-menu.js';
import { itemDisabled, type MenuRuleState } from './AppMenuBar.js';
import { searchActions, selectedClipSupportsSpeed } from './editor-state.js';

const project = {
  compositions: {
    main: {
      tracks: [
        {
          clips: [
            { id: 'video-1', kind: 'video' },
            { id: 'image-1', kind: 'image' },
            { id: 'audio-1', kind: 'audio' },
            { id: 'text-1', kind: 'text' },
          ],
        },
      ],
    },
  },
};

function menuItem(id: string) {
  const found = APP_MENU_GROUPS.flatMap((group) => group.items).find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing menu item ${id}`);
  return found;
}

function paletteEntry(id: string) {
  const found = searchActions('').find((action) => action.id === id);
  if (found === undefined) throw new Error(`missing palette entry ${id}`);
  return found;
}

describe('Clip > Speed only applies to a video clip', () => {
  it('reads the selection the way the Inspector does: the first selected clip the timeline holds', () => {
    expect(selectedClipSupportsSpeed(project, ['video-1'])).toBe(true);
    expect(selectedClipSupportsSpeed(project, ['image-1'])).toBe(false);
    expect(selectedClipSupportsSpeed(project, ['audio-1'])).toBe(false);
    expect(selectedClipSupportsSpeed(project, ['text-1'])).toBe(false);
    expect(selectedClipSupportsSpeed(project, [])).toBe(false);
    expect(selectedClipSupportsSpeed(project, ['missing', 'video-1'])).toBe(true);
    expect(selectedClipSupportsSpeed(project, ['image-1', 'video-1'])).toBe(false);
  });

  it('disables Speed in the menu and the palette for an image, audio or text clip', () => {
    const state: MenuRuleState = {
      canUndo: true,
      canRedo: true,
      hasSelection: true,
      supportsSpeed: selectedClipSupportsSpeed(project, ['image-1']),
      exporting: false,
    };
    expect(itemDisabled(menuItem('clip.speed'), state)).toBe(true);
    expect(itemDisabled(paletteEntry('clip.speed').item, state)).toBe(true);
  });

  it('enables Speed in the menu and the palette for a video clip', () => {
    const state: MenuRuleState = {
      canUndo: true,
      canRedo: true,
      hasSelection: true,
      supportsSpeed: selectedClipSupportsSpeed(project, ['video-1']),
      exporting: false,
    };
    expect(itemDisabled(menuItem('clip.speed'), state)).toBe(false);
    expect(itemDisabled(paletteEntry('clip.speed').item, state)).toBe(false);
  });

  it('disables Speed with no selection even when the flag is set', () => {
    const state: MenuRuleState = {
      canUndo: true,
      canRedo: true,
      hasSelection: false,
      supportsSpeed: true,
      exporting: false,
    };
    expect(itemDisabled(menuItem('clip.speed'), state)).toBe(true);
  });
});

describe('menu and palette use one disabled rule', () => {
  const flags: readonly boolean[] = [false, true];
  const combinations: MenuRuleState[] = flags.flatMap((canUndo) =>
    flags.flatMap((canRedo) =>
      flags.flatMap((hasSelection) =>
        flags.flatMap((supportsSpeed) =>
          flags.map((exporting) => ({
            canUndo,
            canRedo,
            hasSelection,
            supportsSpeed,
            exporting,
          })),
        ),
      ),
    ),
  );

  it('gives every menu item the same disabled state in the palette, for every combination', () => {
    const mismatches: string[] = [];
    for (const state of combinations) {
      for (const group of APP_MENU_GROUPS) {
        for (const item of group.items) {
          const fromMenu = itemDisabled(item, state);
          const fromPalette = itemDisabled(paletteEntry(item.id).item, state);
          if (fromMenu !== fromPalette) mismatches.push(`${item.id} ${JSON.stringify(state)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
