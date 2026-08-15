import {
  DEFAULT_TEXT_STYLE_V1,
  type TextDocumentV1,
  type TextStyleV1,
} from '@joy-media/project-schema';

export interface TextTemplateV1 {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly category: 'Titles' | 'Lower thirds' | 'Highlights' | 'Social';
  readonly sample: string;
  readonly document: TextDocumentV1;
  readonly style: TextStyleV1;
}

const run = (text: string, highlightColor?: string) => ({
  text,
  ...(highlightColor === undefined ? {} : { style: { highlightColor } }),
});

function template(
  id: string,
  label: string,
  description: string,
  category: TextTemplateV1['category'],
  sample: string,
  style: Partial<TextStyleV1> = {},
  runs = [run(sample)],
): TextTemplateV1 {
  return {
    id,
    label,
    description,
    category,
    sample,
    document: { version: 1, blocks: [{ id: `${id}-block`, runs }] },
    style: { ...DEFAULT_TEXT_STYLE_V1, ...style },
  };
}

export const TEXT_TEMPLATES: readonly TextTemplateV1[] = [
  template(
    'clean-title',
    'Clean Title',
    'Quiet title with clear hierarchy',
    'Titles',
    'A Better Story',
    { fontSizePx: 102, fontWeight: 600 },
  ),
  template(
    'bold-stack',
    'Bold Stack',
    'Three-line editorial headline',
    'Titles',
    'MAKE\nIT\nMOVE',
    { fontSizePx: 120, fontWeight: 850, fill: { kind: 'solid', color: '#f5f0e8' } },
  ),
  template(
    'cinematic-wide',
    'Cinematic Wide',
    'Wide tracking for openings',
    'Titles',
    'BEYOND THE FRAME',
    { fontSizePx: 70, fontWeight: 500, tracking: 8, fill: { kind: 'solid', color: '#f6c453' } },
  ),
  template(
    'outline-impact',
    'Outline Impact',
    'High-contrast outlined title',
    'Titles',
    'UNMUTED',
    {
      fontSizePx: 124,
      fontWeight: 850,
      fill: { kind: 'solid', color: '#111318' },
      stroke: { color: '#f6c453', widthPx: 4, opacity: 1 },
    },
  ),
  template(
    'gradient-headline',
    'Gradient Headline',
    'Warm gradient headline',
    'Titles',
    'Color in Motion',
    {
      fontSizePx: 104,
      fill: {
        kind: 'linear-gradient',
        angleDeg: 20,
        stops: [
          { offset: 0, color: '#f6c453' },
          { offset: 1, color: '#ff7a45' },
        ],
      },
    },
  ),
  template(
    'hero-title',
    'Hero Title',
    'Centered cinematic title',
    'Titles',
    'The story starts here',
    {
      fontFamily: 'Modam Pro',
      fontSizePx: 92,
      direction: 'ltr',
      align: 'center',
      fill: { kind: 'solid', color: '#f8f2e6' },
    },
  ),
  template(
    'name-role',
    'Name + Role',
    'Editable name and role blocks',
    'Lower thirds',
    'Hadi Moti\nCreative Director',
    { fontSizePx: 74, fontWeight: 700, align: 'start' },
    [run('Hadi Moti'), run('\nCreative Director', '#f6c453')],
  ),
  template(
    'accent-lower-third',
    'Accent Lower Third',
    'Name with a bright accent run',
    'Lower thirds',
    'JOY Media / Tehran',
    { fontSizePx: 68, fontWeight: 650, align: 'start' },
    [run('JOY Media / '), run('Tehran', '#f6c453')],
  ),
  template('social-handle', 'Social Handle', 'Compact creator handle', 'Social', '@joystudio', {
    fontSizePx: 64,
    fontWeight: 650,
    fill: { kind: 'solid', color: '#b9e7ff' },
  }),
  template(
    'news-line',
    'News Line',
    'Breaking-line utility treatment',
    'Social',
    'NEW RELEASE / TODAY',
    { fontSizePx: 62, fontWeight: 800, tracking: 2, fill: { kind: 'solid', color: '#ff8b66' } },
  ),
  template(
    'highlight-word',
    'Highlight Word',
    'One highlighted word inside a sentence',
    'Highlights',
    'Make every FRAME count',
    { fontSizePx: 88, fontWeight: 650 },
    [run('Make every '), run('FRAME', '#f6c453'), run(' count')],
  ),
  template(
    'marker-highlight',
    'Marker Highlight',
    'Soft marker-colored emphasis',
    'Highlights',
    'Designed for creators',
    { fontSizePx: 82, fontWeight: 650 },
    [run('Designed for '), run('creators', '#8ee4bf')],
  ),
  template(
    'neon-keyword',
    'Neon Keyword',
    'Keyword with glow-ready color',
    'Highlights',
    'Turn ON imagination',
    {
      fontSizePx: 100,
      fontWeight: 800,
      fill: { kind: 'solid', color: '#b9f6ff' },
      glow: { color: '#53d9ff', radiusPx: 18, strength: 0.8 },
    },
    [run('Turn '), run('ON', '#53d9ff'), run(' imagination')],
  ),
  template(
    'quote-focus',
    'Quote Focus',
    'Centered quote with a warm keyword',
    'Social',
    'Ideas become visible',
    { fontSizePx: 88, fontWeight: 520, italic: true },
    [run('Ideas become '), run('visible', '#f6c453')],
  ),
  template(
    'number-statistic',
    'Number / Statistic',
    'Large number and supporting line',
    'Social',
    '10× FASTER',
    {
      fontSizePx: 128,
      fontWeight: 850,
      fill: {
        kind: 'linear-gradient',
        angleDeg: 15,
        stops: [
          { offset: 0, color: '#f6c453' },
          { offset: 1, color: '#fff4c9' },
        ],
      },
    },
    [run('10×', '#f6c453'), run(' FASTER')],
  ),
  template('cta-punch', 'CTA Punch', 'Short call-to-action treatment', 'Social', 'START CREATING', {
    fontSizePx: 98,
    fontWeight: 850,
    fill: { kind: 'solid', color: '#ffffff' },
    stroke: { color: '#f6c453', widthPx: 2, opacity: 1 },
  }),
];

export function textTemplateById(id: string): TextTemplateV1 | undefined {
  return TEXT_TEMPLATES.find((template) => template.id === id);
}
