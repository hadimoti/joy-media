import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoginGate } from './LoginGate.js';

describe('LoginGate containment', () => {
  it('marks the mounted editor inert and hidden while the gate is checking', () => {
    const markup = renderToStaticMarkup(
      <LoginGate>
        <button type="button">Editor action</button>
      </LoginGate>,
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('inert');
    expect(markup).toContain('Editor action');
  });
});
