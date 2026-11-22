import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { timelineControlCases } from './timeline-control-cases.mjs';

const read = (rel) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
const PANEL = 'apps/editor-web/src/TimelinePanel.tsx';
const VISIBILITY = 'apps/editor-web/src/TimelineTrackVisibilityButton.tsx';
const COLOR_MENU = 'apps/editor-web/src/TimelineTrackColorMenu.tsx';
const COMMANDS = 'apps/editor-web/src/commands/timeline-commands.tsx';

const FIELDS = ['id', 'label', 'scope', 'prerequisite', 'expected', 'evidence'];
const SCOPE_PREFIXES = ['toolbar.', 'track-list.', 'track-row.'];

/**
 * Every `aria-label=` attribute in each inventoried file, one claim per attribute.
 * `labels` lists the case labels it renders (control claims). `static` claims are
 * non-interactive (groups, notes, status spans) and are not inventoried as controls.
 * `fragment` must occur verbatim in the source, so a renamed attribute fails here.
 */
const SOURCE_CLAIMS = {
  [PANEL]: [
    { fragment: 'aria-label={`Gap in ', static: 'role="note" gap marker, not interactive' },
    { fragment: 'aria-label={`${label}, ${durationLabel}', labels: ['<clip label>, <duration>, <start>–<end>'] },
    { fragment: 'aria-label={`Trim start of ${label}`}', labels: ['Trim start of <clip label>'] },
    { fragment: 'aria-label={`Trim end of ${label}`}', labels: ['Trim end of <clip label>'] },
    {
      fragment: "aria-label={`${family === 'audio' ? 'Audio' : 'Visual'} runway.",
      labels: [
        'Visual runway. Open media library to add a layer.',
        'Audio runway. Open media library to add a layer.',
      ],
    },
    { fragment: 'aria-label="Merged timeline navigation"', static: 'role-less group wrapper' },
    { fragment: 'aria-label="Back to parent timeline"', labels: ['Back to parent timeline'] },
    { fragment: "aria-label={playing ? 'Pause' : 'Play'}", labels: ['Play', 'Pause'] },
    { fragment: 'aria-label="Back one second"', labels: ['Back one second'] },
    { fragment: 'aria-label="Forward one second"', labels: ['Forward one second'] },
    { fragment: 'aria-label="Add marker at playhead"', labels: ['Add marker at playhead'] },
    { fragment: 'aria-label="Add video track"', labels: ['Add video track'] },
    { fragment: 'aria-label="Add audio track"', labels: ['Add audio track'] },
    { fragment: 'aria-label="Select tool"', labels: ['Select tool'] },
    { fragment: 'aria-label="Split tool"', labels: ['Split tool'] },
    {
      fragment: "aria-label={snapping ? 'Snapping enabled' : 'Snapping disabled'}",
      labels: ['Snapping enabled', 'Snapping disabled'],
    },
    { fragment: 'aria-label="Copy clip"', labels: ['Copy clip'] },
    { fragment: 'aria-label="Cut clip"', labels: ['Cut clip'] },
    { fragment: 'aria-label="Paste clip"', labels: ['Paste clip'] },
    { fragment: 'aria-label="Duplicate clip"', labels: ['Duplicate clip'] },
    {
      fragment: "aria-label={selectedMarkerId !== undefined ? 'Remove marker' : 'Ripple delete'}",
      labels: ['Remove marker', 'Ripple delete'],
    },
    { fragment: 'aria-label="Zoom out"', labels: ['Zoom out'] },
    { fragment: 'aria-label="Timeline zoom"', labels: ['Timeline zoom'] },
    { fragment: 'aria-label="Zoom in"', labels: ['Zoom in'] },
    { fragment: 'aria-label="Fit timeline to width"', labels: ['Fit timeline to width'] },
    { fragment: "aria-label={autoFit ? 'Fit mode' : 'Follow mode'}", static: 'zoom mode status span' },
    { fragment: 'aria-label={`${trackCode} ${trackName} track`}', static: 'role=group track container' },
    { fragment: 'aria-label="Noise reduction (DeepFilterNet) active"', static: 'status pill span' },
    { fragment: 'aria-label="Loudness normalization (EBU R128) active"', static: 'status pill span' },
    { fragment: 'aria-label={`${trackCode} track controls`}', static: 'group wrapper for track buttons' },
    {
      fragment: 'aria-label={`Change label color for ${trackName}`}',
      labels: ['Change label color for <track name>'],
    },
    { fragment: 'aria-label={`Lock ${trackCode}`}', labels: ['Lock <track code>'] },
    {
      fragment: 'aria-label={`${track.muted ? \'Unmute\' : \'Mute\'} ${trackCode}`}',
      labels: ['Mute <track code>', 'Unmute <track code>'],
    },
    { fragment: 'aria-label={`Solo ${trackCode}`}', labels: ['Solo <track code>'] },
    {
      fragment: 'aria-label={`Insert media on ${trackCode} track`}',
      labels: ['Insert media on <track code> track'],
    },
    {
      fragment: 'aria-label={`${marker.label}. Delete to remove.`}',
      labels: ['<marker label>. Delete to remove.'],
    },
    { fragment: 'aria-label={`Remove ${marker.label}`}', labels: ['Remove <marker label>'] },
    { fragment: 'aria-label="Add an empty track"', static: 'role=group wrapper for add-track buttons' },
    { fragment: 'aria-label="Add track"', labels: ['Add track'] },
    { fragment: 'aria-label="Add audio track"', labels: ['Add audio track'] },
  ],
  [VISIBILITY]: [
    {
      fragment: 'aria-label={visible ? `Hide ${trackLabel}` : `Show ${trackLabel}`}',
      labels: ['Hide <track code>', 'Show <track code>'],
    },
  ],
  [COLOR_MENU]: [
    { fragment: 'aria-label="Track color"', labels: ['Track color'] },
    // Choice names come from COLOR_LABELS, checked separately below.
    { fragment: 'aria-label={name}', labels: ['Default'], colorLabels: true },
  ],
};

/** Buttons named by visible text (no aria-label attribute), anchored on a unique attribute. */
const TEXT_NAMED_CONTROLS = [
  { file: PANEL, fragment: 'aria-expanded={dataLanesOpen}', label: 'Data Lanes' },
];

const CONTEXT_MENU_LABELS = {
  [COMMANDS]: ["label: 'Remove Track'", "label: currentVisible ? 'Hide Track' : 'Show Track'"],
};

const caseLabels = timelineControlCases.map((c) => c.label);

function claimedLabels() {
  return Object.values(SOURCE_CLAIMS)
    .flat()
    .flatMap((claim) => claim.labels ?? []);
}

function ariaLabelAttributeCount(src) {
  return src
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && /aria-label=/.test(line)).length;
}

test('case ids are unique and non-empty strings', () => {
  const ids = timelineControlCases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate case id');
  for (const id of ids) assert.equal(typeof id, 'string');
  for (const c of timelineControlCases) assert.notEqual(c.id.trim(), '');
});

test('rows and the case list are frozen with exactly the six string fields', () => {
  assert.ok(Object.isFrozen(timelineControlCases), 'case list must be frozen');
  for (const c of timelineControlCases) {
    assert.ok(Object.isFrozen(c), `row ${c.id} must be frozen`);
    assert.deepEqual(Object.keys(c).sort(), [...FIELDS].sort(), `row ${c.id} fields`);
    for (const field of FIELDS) {
      assert.equal(typeof c[field], 'string', `${c.id}.${field} must be a string`);
      assert.notEqual(c[field].trim(), '', `${c.id}.${field} must not be empty`);
    }
  }
});

test('every scope names the toolbar, the track list or a track row', () => {
  for (const c of timelineControlCases) {
    assert.ok(
      SCOPE_PREFIXES.some((prefix) => c.scope.startsWith(prefix)),
      `${c.id} scope "${c.scope}" is not toolbar, track-list or track-row`,
    );
  }
});

test('repeated labels have distinct scopes', () => {
  const byLabel = new Map();
  for (const c of timelineControlCases) {
    byLabel.set(c.label, [...(byLabel.get(c.label) ?? []), c]);
  }
  const repeated = [...byLabel.entries()].filter(([, rows]) => rows.length > 1);
  assert.ok(repeated.length > 0, 'expected at least one repeated label (Add audio track)');
  for (const [label, rows] of repeated) {
    const scopes = rows.map((r) => r.scope);
    assert.equal(new Set(scopes).size, scopes.length, `"${label}" repeats in one scope: ${scopes}`);
  }
  // The toolbar and track-list copies of "Add audio track" are the known repeat.
  const addAudio = byLabel.get('Add audio track').map((r) => r.scope).sort();
  assert.deepEqual(addAudio, ['toolbar.add', 'track-list.add-empty-track']);
});

test('separate Play and Pause rows, and marker vs clip removal are separate rows', () => {
  const labels = new Set(caseLabels);
  for (const label of ['Play', 'Pause', 'Ripple delete', 'Remove marker']) {
    assert.ok(labels.has(label), `missing row for "${label}"`);
  }
  const ripple = timelineControlCases.find((c) => c.label === 'Ripple delete');
  const removeMarker = timelineControlCases.find((c) => c.label === 'Remove marker');
  assert.match(ripple.expected, /clip removal/);
  assert.match(removeMarker.expected, /marker removal/);
});

test('track eye, color, lock, mute, solo and insertion each have a row per state or action', () => {
  const labels = new Set(caseLabels);
  for (const label of [
    'Change label color for <track name>',
    'Lock <track code>',
    'Hide <track code>',
    'Show <track code>',
    'Mute <track code>',
    'Unmute <track code>',
    'Solo <track code>',
    'Insert media on <track code> track',
  ]) {
    assert.ok(labels.has(label), `missing track-row control "${label}"`);
  }
});

test('both Add audio track placements and the Add video track placements are inventoried', () => {
  const addAudio = timelineControlCases.filter((c) => c.label === 'Add audio track');
  assert.equal(addAudio.length, 2);
  assert.deepEqual(addAudio.map((c) => c.scope).sort(), ['toolbar.add', 'track-list.add-empty-track']);
  assert.ok(caseLabels.includes('Add video track'));
  assert.ok(caseLabels.includes('Add track'));
});

test('the color menu lists every COLOR_LABELS choice plus Default', () => {
  const src = read(COLOR_MENU);
  const block = src.slice(src.indexOf('const COLOR_LABELS'), src.indexOf('};', src.indexOf('const COLOR_LABELS')));
  const names = [...block.matchAll(/:\s*'([A-Za-z]+)'/g)].map((m) => m[1]).sort();
  assert.ok(names.length >= 8, 'COLOR_LABELS block parsed');
  const colorRows = timelineControlCases
    .filter((c) => c.scope === 'track-row.color-menu' && c.label !== 'Track color')
    .map((c) => c.label)
    .sort();
  assert.deepEqual(colorRows, ['Default', ...names].sort());
});

test('new Split at playhead action is absent in baseline and marked pending', () => {
  const row = timelineControlCases.find((c) => c.label === 'Split at playhead');
  assert.ok(row, 'missing Split at playhead row');
  assert.match(row.expected, /^ABSENT in baseline; pending implementation/);
  assert.equal(
    read(PANEL).includes('Split at playhead'),
    false,
    'TimelinePanel now names "Split at playhead": flip this row from absent to present and update its evidence',
  );
});

test('every aria-label attribute in the inventoried files is claimed, and each claim exists in source', () => {
  for (const [file, claims] of Object.entries(SOURCE_CLAIMS)) {
    const src = read(file);
    assert.equal(
      ariaLabelAttributeCount(src),
      claims.length,
      `${file}: aria-label count changed; inventory the new control or mark it static`,
    );
    for (const claim of claims) {
      assert.ok(src.includes(claim.fragment), `${file}: claimed fragment not found: ${claim.fragment}`);
    }
  }
});

test('every control claim names only inventoried labels', () => {
  for (const claim of Object.values(SOURCE_CLAIMS).flat()) {
    for (const label of claim.labels ?? []) {
      if (claim.colorLabels) continue;
      assert.ok(caseLabels.includes(label), `claimed label "${label}" has no case row`);
    }
  }
});

test('every inventoried case label is claimed by source or by a menu', () => {
  const claimed = new Set(claimedLabels());
  for (const label of ['Default', 'Violet', 'Iris', 'Caribbean', 'Lavender', 'Cerulean', 'Forest', 'Rose', 'Mango']) {
    claimed.add(label);
  }
  claimed.add('Remove Track');
  claimed.add('Hide Track');
  claimed.add('Show Track');
  for (const { file, fragment, label } of TEXT_NAMED_CONTROLS) {
    assert.ok(read(file).includes(fragment), `${file}: text-named control anchor not found: ${fragment}`);
    claimed.add(label);
  }
  // Pending rows are absent from source by design; the absence test above covers them.
  const pending = new Set(['Split at playhead']);
  for (const label of caseLabels) {
    if (pending.has(label)) continue;
    assert.ok(claimed.has(label), `case "${label}" is not claimed by any source attribute or menu`);
  }
});

test('track header context menu labels exist in the command source', () => {
  const src = read(COMMANDS);
  for (const fragment of CONTEXT_MENU_LABELS[COMMANDS]) {
    assert.ok(src.includes(fragment), `missing context menu fragment: ${fragment}`);
  }
});
