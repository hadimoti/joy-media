import { describe, expect, it } from 'vitest';
import { monitorFrameRect, monitorZoomShortcut } from './MonitorViewport.js';

const key = (
  keyValue: string,
  code: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
) => ({
  key: keyValue,
  code,
  ctrlKey: modifiers.ctrlKey ?? false,
  metaKey: modifiers.metaKey ?? false,
  altKey: modifiers.altKey ?? false,
});

describe('monitor zoom shortcuts', () => {
  it('maps Ctrl+0, Ctrl+1, Ctrl+plus and Ctrl+minus', () => {
    expect(monitorZoomShortcut(key('0', 'Digit0', { ctrlKey: true }))).toBe('fit');
    expect(monitorZoomShortcut(key('1', 'Digit1', { ctrlKey: true }))).toBe('actual');
    expect(monitorZoomShortcut(key('=', 'Equal', { ctrlKey: true }))).toBe('in');
    expect(monitorZoomShortcut(key('+', 'Equal', { ctrlKey: true }))).toBe('in');
    expect(monitorZoomShortcut(key('+', 'NumpadAdd', { ctrlKey: true }))).toBe('in');
    expect(monitorZoomShortcut(key('-', 'Minus', { ctrlKey: true }))).toBe('out');
    expect(monitorZoomShortcut(key('-', 'NumpadSubtract', { ctrlKey: true }))).toBe('out');
    expect(monitorZoomShortcut(key('0', 'Digit0', { metaKey: true }))).toBe('fit');
  });

  it('ignores the keys without Ctrl, with Alt, and other Ctrl keys', () => {
    expect(monitorZoomShortcut(key('0', 'Digit0'))).toBeUndefined();
    expect(monitorZoomShortcut(key('-', 'Minus'))).toBeUndefined();
    expect(
      monitorZoomShortcut(key('0', 'Digit0', { ctrlKey: true, altKey: true })),
    ).toBeUndefined();
    expect(monitorZoomShortcut(key('z', 'KeyZ', { ctrlKey: true }))).toBeUndefined();
    expect(monitorZoomShortcut(key('k', 'KeyK', { ctrlKey: true }))).toBeUndefined();
  });
});

describe('monitor frame rect', () => {
  it('places the authored frame by the view', () => {
    expect(
      monitorFrameRect({ zoom: 0.5, panX: 12, panY: -4 }, { width: 1080, height: 1920 }),
    ).toEqual({ left: '12px', top: '-4px', width: '540px', height: '960px' });
  });
});
