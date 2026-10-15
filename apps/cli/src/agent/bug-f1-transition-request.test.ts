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
