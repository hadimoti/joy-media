import { describe, expect, it } from 'vitest';
import { PAGE_FILES, renderSite } from './render.mjs';
import { REPOSITORY_URL, downloadUrl, parseSha256Sums, payloadNames } from './release.mjs';

const TAG = 'v1.1.0';
const NAMES = payloadNames(TAG);

/** A SHA256SUMS.txt with distinct, valid hashes for the payload set. */
function sumsText(names: string[] = NAMES): string {
  return names.map((name, index) => `${String(index + 1).repeat(64)}  ${name}`).join('\n') + '\n';
}

function build(sums?: string) {
  if (sums === undefined) return renderSite({ tag: TAG, commit: 'abc123' });
  const parsed = parseSha256Sums(sums, TAG);
  return renderSite({ tag: TAG, commit: 'abc123', sums: parsed, sumsSha256: 'f'.repeat(64) });
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
}

describe('parseSha256Sums (PLAN-v4 7b)', () => {
  it('accepts a file whose names equal the payload set', () => {
    const parsed = parseSha256Sums(sumsText(), TAG);
    expect([...parsed.keys()].sort()).toEqual([...NAMES].sort());
    expect(parsed.get('joy-media.exe')).toBe('2'.repeat(64));
  });

  it('rejects a missing payload name', () => {
    expect(() => parseSha256Sums(sumsText(NAMES.slice(1)), TAG)).toThrow(/do not match/);
  });

  it('rejects an extra name', () => {
    expect(() => parseSha256Sums(sumsText([...NAMES, 'extra.bin']), TAG)).toThrow(/do not match/);
  });

  it('rejects a line that lists SHA256SUMS.txt itself', () => {
    const text = sumsText() + `${'a'.repeat(64)}  SHA256SUMS.txt\n`;
    expect(() => parseSha256Sums(text, TAG)).toThrow(/must not list itself/);
  });

  it('rejects uppercase or non-hex hashes', () => {
    const upper = sumsText().replace(/^1{64}/, 'A'.repeat(64));
    expect(() => parseSha256Sums(upper, TAG)).toThrow(/lowercase hex/);
    const short = sumsText().replace(/^1{64}/, '1'.repeat(63));
    expect(() => parseSha256Sums(short, TAG)).toThrow(/lowercase hex/);
  });

  it('rejects a duplicate entry', () => {
    const text = sumsText() + sumsText().split('\n')[0] + '\n';
    expect(() => parseSha256Sums(text, TAG)).toThrow(/more than once/);
  });
});

describe('release tag and download links', () => {
  it('rejects tags that are not vX.Y.Z', () => {
    expect(() => renderSite({ tag: 'latest', commit: 'x' })).toThrow(/v1\.2\.3/);
    expect(() => renderSite({ tag: '1.1.0', commit: 'x' })).toThrow(/v1\.2\.3/);
  });

  it('builds tag-specific GitHub URLs, never /latest/download/', () => {
    for (const name of NAMES) {
      const url = downloadUrl(TAG, name);
      expect(url).toBe(`${REPOSITORY_URL}/releases/download/${TAG}/${name}`);
      expect(url).not.toContain('/latest/');
    }
  });
});

describe('placeholder build (no SHA256SUMS.txt supplied)', () => {
  const files = build();

  it('marks every hash cell as a placeholder and never shows a digest', () => {
    const html = files['download.html'];
    expect(html.match(/data-sha256-state="placeholder"/g)).toHaveLength(NAMES.length);
    expect(html).not.toMatch(/data-sha256-state="published"/);
    expect(html).toContain('not published yet');
  });

  it('records hash_source=placeholder and the release tag in build.txt', () => {
    expect(files['build.txt']).toContain('hash_source=placeholder');
    expect(files['build.txt']).toContain(`release_tag=${TAG}`);
    expect(files['build.txt']).toContain('site_commit=abc123');
    expect(files['build.txt']).not.toContain('sha256sums_sha256=');
  });

  it('links every payload file to its tag-specific URL', () => {
    const links = hrefs(files['download.html']).filter((href) =>
      href.includes('/releases/download/'),
    );
    expect(links.sort()).toEqual(NAMES.map((name) => downloadUrl(TAG, name)).sort());
  });
});

describe('published build (SHA256SUMS.txt supplied)', () => {
  const text = sumsText();
  const files = build(text);

  it('shows each displayed hash equal to that tag line', () => {
    const parsed = parseSha256Sums(text, TAG);
    for (const name of NAMES) {
      expect(files['download.html']).toContain(
        `<code data-sha256-state="published">${parsed.get(name)}</code>`,
      );
    }
    expect(files['download.html']).not.toContain('data-sha256-state="placeholder"');
  });

  it('records the SHA256SUMS.txt digest in build.txt', () => {
    expect(files['build.txt']).toContain('hash_source=SHA256SUMS.txt');
    expect(files['build.txt']).toContain(`sha256sums_sha256=${'f'.repeat(64)}`);
  });

  it('refuses sums without their digest', () => {
    expect(() =>
      renderSite({ tag: TAG, commit: 'x', sums: parseSha256Sums(text, TAG), sumsSha256: null }),
    ).toThrow(/sumsSha256 must be given/);
  });
});

describe('static checks (PLAN-v4 7e, source and build)', () => {
  const files = build();
  const markup = Object.entries(files).filter(([path]) => path.endsWith('.html'));

  it('contains no fetch, XHR, beacon, form, WebSocket, script or src attribute', () => {
    for (const [path, html] of markup) {
      expect(html, path).not.toMatch(/fetch\(/);
      expect(html, path).not.toMatch(/XMLHttpRequest/);
      expect(html, path).not.toMatch(/sendBeacon/);
      expect(html, path).not.toMatch(/<form/i);
      expect(html, path).not.toMatch(/WebSocket/);
      expect(html, path).not.toMatch(/<script/i);
      expect(html, path).not.toMatch(/\ssrc=/);
    }
  });

  it('serves no /api routes and links to none', () => {
    for (const [path, html] of markup) {
      for (const href of hrefs(html)) {
        expect(href.startsWith('/api'), `${path} links to ${href}`).toBe(false);
      }
    }
  });

  it('allows only GitHub-repository links externally, and internal links resolve', () => {
    const served = new Set(Object.keys(files));
    for (const [path, html] of markup) {
      for (const href of hrefs(html)) {
        if (href.startsWith('#')) {
          expect(html.includes(`id="${href.slice(1)}"`), `${path} fragment ${href}`).toBe(true);
        } else if (href.startsWith('https://')) {
          expect(href.startsWith(REPOSITORY_URL), `${path} external link ${href}`).toBe(true);
        } else if (href.startsWith('/')) {
          const target = href.split('#')[0];
          const page =
            target === '/' ? 'index.html' : (PAGE_FILES as Record<string, string>)[target];
          const asset = target.slice(1);
          const resolves = page !== undefined ? served.has(page) : served.has(asset);
          expect(resolves, `${path} internal link ${href}`).toBe(true);
        } else {
          throw new Error(`${path} has a link that is neither internal nor https: ${href}`);
        }
      }
    }
  });

  it('sends a strict CSP without scripts, plus nosniff', () => {
    expect(files['_headers']).toContain("script-src 'none'");
    expect(files['_headers']).toContain("connect-src 'none'");
    expect(files['_headers']).toContain('X-Content-Type-Options: nosniff');
  });

  it('has a 404 page that is not the home page', () => {
    expect(files['404.html']).toContain('Page not found');
  });
});
