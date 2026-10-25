/**
 * Caption direction on the drawn pixels: a right-to-left caption line is drawn with its first word on
 * the right, and the same words embedded left to right are drawn the other way round. The test renders
 * with the bundled caption face and compares the leftmost and rightmost ink with each word drawn alone.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notoSansArabicArabic400Path } from '@joy-media/html-scene-runtime';
import { compileCaptionAss, type AssCaptionCue } from './captions-ass.js';

const WIDTH = 640;
const HEIGHT = 360;
const PERSIAN = 'سلام';
const LATIN = 'Hello';
const LEFT_TO_RIGHT_EMBEDDING = String.fromCodePoint(0x202a);
const POP_DIRECTIONAL_FORMATTING = String.fromCodePoint(0x202c);
/** Ink is white fill; the black outline is darker than this. */
const INK_THRESHOLD = 96;
/** The drawn words match their reference drawing this closely at the line's ends. */
const MATCH_SHARE = 0.85;

let folder: string;

function captionDocument(text: string, direction: 'ltr' | 'rtl' | 'auto'): string {
  return compileCaptionAss({
    width: WIDTH,
    height: HEIGHT,
    fontFamily: 'Noto Sans Arabic',
    cues: [{ text, startUs: 0, endUs: 1_000_000, direction }],
  });
}

/** Draws one caption document and returns one flag per column: whether the column holds ink. */
function drawColumns(name: string, document: string): boolean[] {
  writeFileSync(join(folder, `${name}.ass`), document, 'utf8');
  const drawn = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${WIDTH}x${HEIGHT}:d=1`,
      '-vf',
      `ass=${name}.ass:fontsdir=fonts`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      `${name}.rgb`,
    ],
    { cwd: folder, encoding: 'utf8' },
  );
  expect(drawn.status, drawn.stderr).toBe(0);
  const frame = readFileSync(join(folder, `${name}.rgb`));
  const columns = new Array<boolean>(WIDTH).fill(false);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 3;
      if ((frame[offset]! + frame[offset + 1]! + frame[offset + 2]!) / 3 > INK_THRESHOLD) {
        columns[x] = true;
      }
    }
  }
  return columns;
}

/** The columns from the first ink column to the last: the word's own profile. */
function inkProfile(columns: boolean[]): boolean[] {
  return columns.slice(columns.indexOf(true), columns.lastIndexOf(true) + 1);
}

/** The share of the word's columns, starting at `start`, that agree with the word drawn alone. */
function agreement(columns: boolean[], start: number, word: boolean[]): number {
  const same = word.filter((ink, index) => columns[start + index] === ink).length;
  return same / word.length;
}

/** Agreement of each end of the drawn line with each reference word. */
function endAgreement(columns: boolean[], latin: boolean[], persian: boolean[]) {
  const first = columns.indexOf(true);
  const last = columns.lastIndexOf(true);
  return {
    leftLatin: agreement(columns, first, latin),
    leftPersian: agreement(columns, first, persian),
    rightPersian: agreement(columns, last - persian.length + 1, persian),
    rightLatin: agreement(columns, last - latin.length + 1, latin),
  };
}

describe('caption direction on the drawn pixels', () => {
  let latinWord: boolean[];
  let persianWord: boolean[];

  beforeAll(() => {
    expect(spawnSync('ffmpeg', ['-version']).status, 'ffmpeg is required').toBe(0);
    folder = mkdtempSync(join(tmpdir(), 'joy-caption-direction-'));
    const fonts = join(folder, 'fonts');
    mkdirSync(fonts);
    const source = dirname(notoSansArabicArabic400Path());
    for (const file of readdirSync(source)) {
      if (file.endsWith('.ttf')) copyFileSync(join(source, file), join(fonts, file));
    }
    latinWord = inkProfile(drawColumns('latin-alone', captionDocument(LATIN, 'ltr')));
    persianWord = inkProfile(drawColumns('persian-alone', captionDocument(PERSIAN, 'rtl')));
  });

  afterAll(() => {
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it('draws a right-to-left line with its first word on the right', () => {
    const edges = endAgreement(
      drawColumns('rtl-line', captionDocument(`${PERSIAN} ${LATIN}`, 'rtl')),
      latinWord,
      persianWord,
    );
    expect(edges.rightPersian).toBeGreaterThanOrEqual(MATCH_SHARE);
    expect(edges.leftLatin).toBeGreaterThanOrEqual(MATCH_SHARE);
  });

  it('draws the same words the other way round when they are embedded left to right', () => {
    const edges = endAgreement(
      drawColumns(
        'ltr-line',
        captionDocument(
          `${LEFT_TO_RIGHT_EMBEDDING}${PERSIAN} ${LATIN}${POP_DIRECTIONAL_FORMATTING}`,
          'ltr',
        ),
      ),
      latinWord,
      persianWord,
    );
    expect(edges.leftPersian).toBeGreaterThanOrEqual(MATCH_SHARE);
    expect(edges.rightLatin).toBeGreaterThanOrEqual(MATCH_SHARE);
  });
});
