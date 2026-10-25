import { describe, expect, it } from 'vitest';
import { compileCaptionAss } from './captions-ass.js';

const base = { width: 1920, height: 1080, fontFamily: 'Arial' };

function failureCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected caption compilation to fail.');
}

describe('compileCaptionAss', () => {
  it('compiles two English cues to the stable ASS golden', () => {
    expect(
      compileCaptionAss({
        ...base,
        cues: [
          { text: 'Hello world', startUs: 0, endUs: 1_000_000 },
          { text: 'Goodbye', startUs: 1_250_000, endUs: 2_000_000 },
        ],
      }),
    ).toBe(
      '[Script Info]\n' +
        'ScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n' +
        '[V4+ Styles]\n' +
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
        'Style: Caption,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,162,1\n\n' +
        '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
        'Dialogue: 0,0:00:00.00,0:00:01.00,Caption,,0,0,0,,Hello world\n' +
        'Dialogue: 0,0:00:01.25,0:00:02.00,Caption,,0,0,0,,Goodbye\n',
    );
  });

  it('preserves Arabic text in logical order for libass bidirectional shaping', () => {
    const arabic = 'مرحبا بالعالم';
    const ass = compileCaptionAss({
      ...base,
      cues: [{ text: arabic, startUs: 0, endUs: 1_000_000, direction: 'rtl' }],
    });
    expect(ass).toContain(`,,${arabic}\n`);
    expect(ass).not.toContain([...arabic].reverse().join(''));
  });

  it('rounds cue boundaries to frame-equivalent centiseconds', () => {
    const ass = compileCaptionAss({
      ...base,
      cues: [{ text: 'rounded', startUs: 15_000, endUs: 1_015_000 }],
      frameRate: { num: 30, den: 1 },
    });
    expect(ass).toContain('Dialogue: 0,0:00:00.02,0:00:01.02,');
  });

  it('rejects boundaries that cannot preserve the visible frame at the rational frame rate', () => {
    expect(
      failureCode(() =>
        compileCaptionAss({
          ...base,
          cues: [{ text: 'too precise', startUs: 1, endUs: 100_000 }],
          frameRate: { num: 120, den: 1 },
        }),
      ),
    ).toMatchObject({ code: 'CAPTION_TIMING_UNREPRESENTABLE' });
  });

  it('uses frozen hard breaks and rejects measured wraps that overflow', () => {
    expect(
      failureCode(() =>
        compileCaptionAss({
          ...base,
          cues: [
            {
              text: 'one two',
              lines: ['one', 'two'],
              measuredWidthsPx: [22, 24],
              maxWidthPx: 20,
              startUs: 0,
              endUs: 1_000_000,
            },
          ],
        }),
      ),
    ).toMatchObject({ code: 'CAPTION_LAYOUT_OVERFLOW' });
  });

  it('escapes ASS braces and backslashes and maps line breaks to a hard break', () => {
    const ass = compileCaptionAss({
      ...base,
      cues: [{ text: 'a{b}\\c\nd', startUs: 0, endUs: 1_000_000 }],
    });
    expect(ass).toContain(',,a\\{b\\}\\\\c\\Nd\n');
  });

  it.each([{ karaoke: true }, { style: { fontSize: 20 } }, { animation: 'fade' }])(
    'refuses karaoke, per-cue styles, and animation tags (%o)',
    (unsupported) => {
      expect(
        failureCode(() =>
          compileCaptionAss({
            ...base,
            cues: [{ text: 'unsupported', startUs: 0, endUs: 1_000_000, ...unsupported }],
          }),
        ),
      ).toMatchObject({ code: 'CAPTION_UNSUPPORTED' });
    },
  );

  it('refuses cue times that collapse at centisecond precision', () => {
    expect(() =>
      compileCaptionAss({ ...base, cues: [{ text: 'too short', startUs: 0, endUs: 4_999 }] }),
    ).toThrow('centisecond');
  });
});
