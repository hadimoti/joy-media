import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkerIcon, TimelineMarkerIcon } from './icons.js';

describe('timeline marker icons', () => {
  it.each([
    ['toolbar marker', <MarkerIcon />],
    ['placed marker', <TimelineMarkerIcon />],
  ])('renders the %s as a currentColor mask', (_name, icon) => {
    const markup = renderToStaticMarkup(icon);

    expect(markup).toContain('class="png-mask-icon"');
    expect(markup).toContain('mask-image:url(');
    expect(markup).not.toContain('<img');
  });
});
