import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { verifyRequestIntent } from './joy-agent.js';
import { fixtureProject } from './scripted-agent.test-helper.js';

// FT1 review (Sol, 2026-10-15): the F1 request check must look at what this run changed, at the
// clips the request names, and at the transition type asked for. Probes P1-P7.
type AnyProject = JoyProjectV1 & { transitions?: unknown[] };
const base = (): AnyProject =>
  fixtureProject({
    assets: { a: 30_000_000, b: 12_000_000, c: 12_000_000 },
    clips: [
      { id: 'clip-a', assetId: 'a', startUs: 0, durationUs: 5_000_000 },
      { id: 'clip-b', assetId: 'b', startUs: 5_000_000, durationUs: 5_000_000 },
      { id: 'clip-c', assetId: 'c', startUs: 10_000_000, durationUs: 5_000_000 },
    ],
  }) as unknown as AnyProject;
const withT = (project: AnyProject, left: string, right: string, type = 'dissolve'): AnyProject =>
  ({
    ...project,
    transitions: [
      ...(project.transitions ?? []),
      { id: `t-${left}`, leftClipId: left, rightClipId: right, type, durationUs: 1_000_000 },
    ],
  }) as AnyProject;
const check = (project: AnyProject, request: string, before?: AnyProject) =>
  verifyRequestIntent(project, request, before);

describe('F1 request verification (FT1 review)', () => {
  it('P1: a crossfade that already existed does not satisfy a request for another pair', () => {
    const pre = withT(base(), 'clip-a', 'clip-b');
    const result = check(pre, 'Add a crossfade between clip B and clip C.', pre);
    expect(result.verified.join(' ')).not.toMatch(/crossfade/i);
    expect(result.unmet).toEqual([
      'request asked for a crossfade between b and c, but this run added none there',
    ]);
  });

  it('P1 control: the crossfade added between the named clips is verified', () => {
    const pre = withT(base(), 'clip-a', 'clip-b');
    const after = withT(pre, 'clip-b', 'clip-c');
    const result = check(after, 'Add a crossfade between clip B and clip C.', pre);
    expect(result.unmet).toEqual([]);
    expect(result.verified).toContain('Request: crossfade between b and c');
  });

  it('a request without named clips needs a crossfade added by this run, not a pre-existing one', () => {
    const pre = withT(base(), 'clip-a', 'clip-b');
    expect(check(pre, 'Add a crossfade.', pre).unmet).toEqual([
      'request asked for a crossfade transition between clips, but this run added none',
    ]);
    expect(check(withT(pre, 'clip-b', 'clip-c'), 'Add a crossfade.', pre).unmet).toEqual([]);
  });

  it('P2: "remove the transition between A and B" is verified when it is gone', () => {
    const pre = withT(base(), 'clip-a', 'clip-b');
    const result = check(base(), 'Remove the transition between A and B.', pre);
    expect(result.unmet).toEqual([]);
    expect(result.verified).toContain('Request: no transition between a and b');
  });

  it('P2 control: a remove request is unmet when the transition is still there', () => {
    const pre = withT(base(), 'clip-a', 'clip-b');
    expect(check(pre, 'Remove the transition between A and B.', pre).unmet).toHaveLength(1);
    expect(check(pre, 'Delete the transition.', pre).unmet).toEqual([
      'request asked to remove a transition, but the timeline has as many as before',
    ]);
    expect(check(base(), 'Delete the transition.', pre).verified).toContain(
      'Request: transition removed',
    );
  });

  it('P3: "no transitions, hard cuts only" adds no transition check', () => {
    const result = check(base(), 'Join the clips with no transitions, hard cuts only.');
    expect(result.unmet).toEqual([]);
    expect(result.verified.join(' ')).not.toMatch(/transition|crossfade/i);
  });

  it.each([
    'Add a crossfade between A and B, but no other transitions.',
    'Crossfade clip A into clip B; hard cuts everywhere else.',
  ])('N1/N2: a negation elsewhere does not cancel a positive request (%s)', (request) => {
    const before = base();
    const nothing = check(before, request, before);
    expect(nothing.verified.join(' ')).not.toMatch(/crossfade/i);
    expect(nothing.unmet).toHaveLength(1);
    const done = check(withT(before, 'clip-a', 'clip-b'), request, before);
    expect(done.unmet).toEqual([]);
    expect(done.verified.join(' ')).toMatch(/crossfade/i);
  });

  it.each([
    "Don't use transitions.",
    'Don\u2019t use transitions.',
    'Dont add any crossfades.',
    'Never add a crossfade.',
    'Avoid transitions between the clips.',
  ])('a negated request adds no transition check and is never verified (%s)', (request) => {
    const before = base();
    for (const project of [before, withT(before, 'clip-a', 'clip-b')]) {
      const result = check(project, request, before);
      expect(result.verified.join(' ')).not.toMatch(/crossfade|transition/i);
      expect(result.unmet).toEqual([]);
    }
  });

  it("still checks the positive part of 'a crossfade between A and B, but don't add other transitions'", () => {
    const before = base();
    const request = "Add a crossfade between A and B, but don't add other transitions.";
    expect(check(before, request, before).unmet).toHaveLength(1);
    expect(check(withT(before, 'clip-a', 'clip-b'), request, before).unmet).toEqual([]);
  });

  it('a negated named pair must not get a new transition (do not add between A and B)', () => {
    const before = base();
    const request = 'Do not add a crossfade between A and B.';
    expect(check(before, request, before)).toEqual({ verified: [], unmet: [] });
    expect(check(withT(before, 'clip-a', 'clip-b'), request, before).unmet).toEqual([
      'request asked for no transition between a and b, but this run added one',
    ]);
  });

  it('N9: "Do not crossfade A and B, but add a crossfade between B and C" is decided per clause', () => {
    const before = base();
    const request = 'Do not crossfade A and B, but add a crossfade between B and C.';
    expect(check(before, request, before).unmet).toEqual([
      'request asked for a crossfade between b and c, but this run added none there',
    ]);
    const right = check(withT(before, 'clip-b', 'clip-c'), request, before);
    expect(right.unmet).toEqual([]);
    expect(right.verified).toContain('Request: crossfade between b and c');
    const wrong = check(withT(before, 'clip-a', 'clip-b'), request, before);
    expect(wrong.unmet).toContain(
      'request asked for no transition between a and b, but this run added one',
    );
    expect(wrong.unmet).toContain(
      'request asked for a crossfade between b and c, but this run added none there',
    );
  });

  it.each(['هیچ ترنزیشنی نگذار', 'بدون ترنزیشن کلیپ‌ها را پشت هم بگذار', 'ترنزیشن نذار'])(
    'N12: Persian negation adds no transition check (%s)',
    (request) => {
      expect(check(base(), request, base())).toEqual({ verified: [], unmet: [] });
    },
  );

  it.each([
    ['X6', 'ترنزیشن بذار و صدا رو قطع نکن'],
    ['X6d', 'ترنزیشن بذار و به متن دست نزن'],
    ['X6c', 'ترنزیشن کراس فید بذار چون نمیخوام کات باشه'],
  ])('%s: an unrelated Persian negated verb keeps the transition check (%s)', (_id, request) => {
    const before = base();
    expect(check(before, request, before).unmet).toEqual([
      'request asked for a crossfade transition between clips, but this run added none',
    ]);
    expect(check(withT(before, 'clip-a', 'clip-b'), request, before).unmet).toEqual([]);
  });

  it.each([
    ['X2', "crossfade A and B and don't add a crossfade between B and C"],
    ['X2b', 'add a crossfade between B and C and do not crossfade A and B'],
  ])('%s: "and <verb>" splits a positive and a negated pair (%s)', (id, request) => {
    const before = base();
    const [want, forbid] = id === 'X2' ? (['a', 'b'] as const) : (['b', 'c'] as const);
    const [no1, no2] = id === 'X2' ? (['b', 'c'] as const) : (['a', 'b'] as const);
    expect(check(before, request, before).unmet).toEqual([
      `request asked for a crossfade between ${want} and ${forbid}, but this run added none there`,
    ]);
    expect(check(withT(before, `clip-${want}`, `clip-${forbid}`), request, before).unmet).toEqual(
      [],
    );
    const wrong = check(withT(before, `clip-${no1}`, `clip-${no2}`), request, before);
    expect(wrong.unmet).toContain(
      `request asked for no transition between ${no1} and ${no2}, but this run added one`,
    );
    expect(wrong.unmet).toContain(
      `request asked for a crossfade between ${want} and ${forbid}, but this run added none there`,
    );
  });

  it('X8: "Avoid jump cuts: add transitions between A and B" is checked', () => {
    const before = base();
    const request = 'Avoid jump cuts: add transitions between A and B';
    expect(check(before, request, before).unmet).toEqual([
      'request asked for a crossfade between a and b, but this run added none there',
    ]);
    expect(check(withT(before, 'clip-a', 'clip-b'), request, before).unmet).toEqual([]);
  });

  it.each([
    ['Y15', 'avoid jump cuts with a crossfade between A and B'],
    ['Y7', 'Never cut abruptly - use a crossfade between A and B'],
    ['Y8', 'no worries crossfade A and B'],
  ])('%s: an English negation of something else keeps the check (%s)', (_id, request) => {
    const before = base();
    expect(check(before, request, before).unmet).toEqual([
      'request asked for a crossfade between a and b, but this run added none there',
    ]);
    expect(check(withT(before, 'clip-a', 'clip-b'), request, before).unmet).toEqual([]);
  });

  it('Y9: a hard cut between A and B does not require A-B; B-C is required', () => {
    const before = base();
    const request = 'hard cut between A and B and a crossfade between B and C';
    expect(check(before, request, before).unmet).toEqual([
      'request asked for a crossfade between b and c, but this run added none there',
    ]);
    expect(check(withT(before, 'clip-b', 'clip-c'), request, before).unmet).toEqual([]);
  });

  it('Y13: a timestamp colon (0:05) does not split the clause', () => {
    const before = base();
    const request = 'add a crossfade at 0:05 between A and B';
    expect(check(before, request, before).unmet).toContain(
      'request asked for a crossfade between a and b, but this run added none there',
    );
    const done = check(withT(before, 'clip-a', 'clip-b'), request, before);
    expect(done.verified).toContain('Request: crossfade between a and b');
    expect(done.unmet.filter((line) => /crossfade|transition/.test(line))).toEqual([]);
  });

  it('FT1f: "not between A and B" after a positive pair forbids A-B', () => {
    const before = base();
    const request = 'Add a crossfade between B and C, not between A and B.';
    expect(check(withT(before, 'clip-b', 'clip-c'), request, before).unmet).toEqual([]);
    const both = withT(withT(before, 'clip-b', 'clip-c'), 'clip-a', 'clip-b');
    expect(check(both, request, before).unmet).toEqual([
      'request asked for no transition between a and b, but this run added one',
    ]);
  });

  it('FT1f: Persian clip references become named pairs (بین کلیپ ۱ و ۲)', () => {
    const before = base();
    const request = 'بین کلیپ ۱ و ۲ کراس فید بذار';
    expect(check(before, request, before).unmet).toEqual([
      'request asked for a crossfade between 1 and 2, but this run added none there',
    ]);
    expect(check(withT(before, 'clip-a', 'clip-b'), request, before).unmet).toEqual([]);
    expect(check(withT(before, 'clip-b', 'clip-c'), request, before).unmet).toEqual([
      'request asked for a crossfade between 1 and 2, but this run added none there',
    ]);
  });

  it('FT1f Y13: "0:05" is not "start at 0"', () => {
    const before = base();
    const done = check(
      withT(before, 'clip-a', 'clip-b'),
      'add a crossfade at 0:05 between A and B',
      before,
    );
    expect(done.verified).not.toContain('Request: clip starts at 0');
  });

  it('P4: Persian "انتقال" meaning "move" is not a transition request', () => {
    const result = check(base(), 'کلیپ دوم را به ابتدا انتقال بده');
    expect(result.unmet.join(' ')).not.toMatch(/transition|crossfade/i);
  });

  it('P4 control: Persian ترنزیشن, or انتقال next to a fade word, is a transition request', () => {
    expect(check(base(), 'بین کلیپ‌ها ترنزیشن بگذار').unmet).toHaveLength(1);
    expect(check(base(), 'انتقال محو بین کلیپ‌ها بگذار').unmet).toHaveLength(1);
    expect(check(withT(base(), 'clip-a', 'clip-b'), 'بین کلیپ‌ها ترنزیشن بگذار').unmet).toEqual([]);
  });

  it('P5: a fade in from black is reported as unsupported, even if a crossfade was added', () => {
    const result = check(withT(base(), 'clip-a', 'clip-b'), 'Fade in the first clip from black.');
    expect(result.verified.join(' ')).not.toMatch(/crossfade|fade/i);
    expect(result.unmet).toEqual([
      'request asked for a fade in/out; fades from or to black are not supported',
    ]);
  });

  it('P6: a slide transition delivered as a crossfade is unsupported, never verified', () => {
    const before = base();
    const result = check(
      withT(before, 'clip-a', 'clip-b'),
      'Add a slide transition between clips A and B.',
      before,
    );
    expect(result.verified.join(' ')).not.toMatch(/crossfade|transition/i);
    expect(result.unmet).toEqual([
      'request asked for a slide transition; only crossfade is supported',
    ]);
  });

  it('P7: two crossfades asked, one given: the missing pair is unmet', () => {
    const result = check(
      withT(base(), 'clip-a', 'clip-b'),
      'Add crossfades between A and B and between B and C.',
      base(),
    );
    expect(result.verified).toContain('Request: crossfade between a and b');
    expect(result.unmet).toEqual([
      'request asked for a crossfade between b and c, but this run added none there',
    ]);
  });

  it('P7 control: both requested crossfades added is verified', () => {
    const result = check(
      withT(withT(base(), 'clip-a', 'clip-b'), 'clip-b', 'clip-c'),
      'Add crossfades between A and B and between B and C.',
      base(),
    );
    expect(result.unmet).toEqual([]);
  });
});
