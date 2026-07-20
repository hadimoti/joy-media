import { describe, expect, it } from 'vitest';
import { TeamTemplateCatalog, validateTeamTemplate } from './index.js';
import type { TeamTemplateV1 } from './index.js';

const template: TeamTemplateV1 = {
  formatVersion: 1,
  id: 'joy.team.product-promo',
  name: 'Product promo',
  version: '1.0.0',
  scope: 'team-private',
  joyApi: '>=1.0.0 <2.0.0',
  variables: {
    title: { type: 'string', default: 'New product' },
    accent: { type: 'color', default: '#e9b949' },
  },
  slots: [
    {
      id: 'hero',
      label: 'Hero media',
      accepts: ['image', 'video'],
      required: true,
      fitPolicy: 'cover',
    },
  ],
  dependencies: { plugins: [], fonts: [], providers: [] },
  protectedRegions: [{ id: 'intro', startUs: 0, endUs: 500_000 }],
  durationRule: 'reflow',
  targetProfiles: [{ width: 1080, height: 1920, durationUs: 5_000_000 }],
  license: { commercialUse: true },
  fallback: 'editable',
};

describe('team/private template catalog', () => {
  it('publishes only complete private templates and preserves their declared contract', () => {
    const catalog = new TeamTemplateCatalog();
    expect(catalog.publish(template)).toEqual([]);
    expect(catalog.list('team-private')).toEqual([template]);
    expect(catalog.resolve(template.id)?.slots[0]).toMatchObject({
      id: 'hero',
      fitPolicy: 'cover',
    });
  });
  it('rejects public scope and incomplete quality contracts', () => {
    expect(validateTeamTemplate({ ...template, scope: 'public' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'template/scope' })]),
    );
    expect(validateTeamTemplate({ ...template, targetProfiles: [] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'template/profiles' })]),
    );
  });
});
