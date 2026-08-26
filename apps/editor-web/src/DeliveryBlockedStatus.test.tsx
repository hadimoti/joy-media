import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeliveryBlockedStatus } from './DeliveryBlockedStatus.js';

describe('DeliveryBlockedStatus', () => {
  it('aggregates channel failures with one concise live announcement and expandable detail', () => {
    const markup = renderToStaticMarkup(
      <DeliveryBlockedStatus
        id="delivery-blocked"
        failures={[
          { channel: 'Quick export', detail: 'Source media is not playable.' },
          { channel: 'Verified delivery', detail: 'No connected render worker is available.' },
        ]}
      />,
    );

    expect(markup).toContain('<summary>Export unavailable</summary>');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Quick export and verified delivery need attention.');
    expect(markup).toContain('Source media is not playable.');
    expect(markup).toContain('No connected render worker is available.');
    expect(markup).not.toContain('asset-');
    expect(markup).not.toContain('motion-scene:');
  });
});
