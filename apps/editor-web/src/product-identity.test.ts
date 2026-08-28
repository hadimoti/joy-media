import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JOY_STUDIO_DESCRIPTION, JOY_STUDIO_NAME } from './product-identity.js';

describe('JOY Studio product identity', () => {
  it('keeps the document title and application metadata on the canonical brand', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

    expect(html).toContain(`<title>${JOY_STUDIO_NAME}</title>`);
    expect(html).toContain(`name="application-name" content="${JOY_STUDIO_NAME}"`);
    expect(html).toContain(`name="description" content="${JOY_STUDIO_DESCRIPTION}"`);
    expect(html).toContain('<link rel="manifest" href="/manifest.json" />');
  });

  it('ships a matching standalone web-app manifest', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'),
    ) as { name?: string; short_name?: string; description?: string; icons?: unknown[] };

    expect(manifest).toMatchObject({
      name: JOY_STUDIO_NAME,
      short_name: JOY_STUDIO_NAME,
      description: JOY_STUDIO_DESCRIPTION,
    });
    expect(manifest.icons).toHaveLength(2);
  });
});
