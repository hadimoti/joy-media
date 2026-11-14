/** A colour as hue (0–360 degrees), saturation (0–1) and value (0–1). */
export interface Hsv {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

/**
 * Accepts "#abc", "abc", "#aabbcc" or "AABBCC" and returns the lowercase
 * "#rrggbb" form, or undefined when the text is not a colour.
 */
export function normalizeHex(input: string): string | undefined {
  const text = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(text)) {
    const [r, g, b] = text.toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toLowerCase()}`;
  return undefined;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** Converts a hex colour to hue, saturation and value. Invalid input reads as black. */
export function hexToHsv(hex: string): Hsv {
  const normal = normalizeHex(hex) ?? '#000000';
  const r = parseInt(normal.slice(1, 3), 16) / 255;
  const g = parseInt(normal.slice(3, 5), 16) / 255;
  const b = parseInt(normal.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

/** Converts hue, saturation and value to a lowercase "#rrggbb" string. */
export function hsvToHex(h: number, s: number, v: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);
  const chroma = val * sat;
  const sector = hue / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (sector < 1) [r, g, b] = [chroma, x, 0];
  else if (sector < 2) [r, g, b] = [x, chroma, 0];
  else if (sector < 3) [r, g, b] = [0, chroma, x];
  else if (sector < 4) [r, g, b] = [0, x, chroma];
  else if (sector < 5) [r, g, b] = [x, 0, chroma];
  else [r, g, b] = [chroma, 0, x];
  const m = val - chroma;
  const channel = (n: number): string =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}
