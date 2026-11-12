// Renders the whole static site to a map of output path to file contents. Pure: the build script
// writes the map to dist/, and the tests read the same map. The site has no scripts, forms, cookies,
// analytics, /api calls or payment links (PLAN-v4 section 7a).

import {
  PLACEHOLDER_HASH,
  REPOSITORY_URL,
  assertReleaseTag,
  downloadUrl,
  payloadNames,
} from './release.mjs';

/** Clean paths as served by Pages. Each maps to an output file below. */
export const NAV = [
  ['/', 'Home'],
  ['/download', 'Download'],
  ['/providers', 'Providers'],
  ['/privacy', 'Privacy'],
  ['/source', 'Source and licence'],
];

/** Clean path to output file. */
export const PAGE_FILES = {
  '/': 'index.html',
  '/download': 'download.html',
  '/providers': 'providers.html',
  '/privacy': 'privacy.html',
  '/source': 'source.html',
};

/**
 * @param {unknown} value
 * @returns {string} HTML-escaped text
 */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {{ title: string, active?: string, body: string }} options
 * @returns {string} a complete HTML document
 */
function layout({ title, active, body }) {
  const nav = NAV.map(
    ([href, label]) =>
      `        <li><a href="${href}"${href === active ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`,
  ).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} | JOY Media</title>
  <meta name="description" content="JOY Media is a free, open-source desktop video editor for Windows.">
  <link rel="stylesheet" href="/site.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="/">JOY Media</a>
    <nav aria-label="Main">
      <ul>
${nav}
      </ul>
    </nav>
  </header>
  <main id="main">
${body}
  </main>
  <footer class="site-footer">
    <p>JOY Media is free and open-source software under the <a href="${REPOSITORY_URL}/blob/main/LICENSE">MIT License</a>.</p>
  </footer>
</body>
</html>
`;
}

/**
 * @param {string} tag
 * @param {Map<string, string> | null} sums null when no SHA256SUMS.txt was supplied
 */
function downloadBody(tag, sums) {
  const rows = payloadNames(tag)
    .map((name) => {
      const hash = sums?.get(name);
      const hashCell = hash
        ? `<code data-sha256-state="published">${hash}</code>`
        : `<code data-sha256-state="placeholder">${PLACEHOLDER_HASH}: available after ${tag} is tagged</code>`;
      return `          <tr>
            <th scope="row"><code>${esc(name)}</code></th>
            <td>${hashCell}</td>
            <td><a href="${downloadUrl(tag, name)}">Download</a></td>
          </tr>`;
    })
    .join('\n');
  const sample = payloadNames(tag)[0];
  const note = sums
    ? ''
    : `
      <p class="notice" role="status">Checksums for ${tag} are not published yet. The hash cells are placeholders and must not be trusted.</p>`;
  return `    <h1>Download JOY Media</h1>
    <p>Version <strong>${tag}</strong> for Windows x64.</p>${note}
    <table>
      <caption>Files in ${tag}</caption>
      <thead>
        <tr><th scope="col">File</th><th scope="col">SHA-256</th><th scope="col">Link</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>

    <h2>Check the file before you run it</h2>
    <p>Open PowerShell in the folder that holds the download and run the command below. Compare the output with the SHA-256 value in the table.</p>
    <pre><code>Get-FileHash .\\${sample} -Algorithm SHA256</code></pre>

    <h2>Before you install</h2>
    <ul>
      <li>JOY Media does not update itself. Return to this page for newer versions.</li>
      <li>The files are not code-signed, so Windows SmartScreen warns about them. Only continue when the hash matches the table.</li>
      <li>Most people want <code>joy-media-setup.exe</code>. The zip is a portable copy that needs no install.</li>
    </ul>

    <h2>Older releases</h2>
    <p>Earlier versions are listed on the <a href="${REPOSITORY_URL}/releases">GitHub releases page</a>.</p>`;
}

const PROVIDERS = [
  ['OpenAI', 'API key', 'International'],
  ['Claude (Anthropic)', 'API key', 'International'],
  ['Google Gemini', 'API key', 'International'],
  ['Grok (xAI)', 'API key or sign-in', 'International'],
  ['MiniMax', 'API key', 'International, China'],
  ['Kimi (Moonshot AI)', 'API key or sign-in', 'International, China'],
  ['OpenRouter', 'API key', 'International'],
  ['ChatGPT (preview)', 'Sign-in only', 'International'],
];

/** @returns {string} the provider table rows, shared by the test and the page */
function providerRows() {
  return PROVIDERS.map(
    ([name, sign, regions]) =>
      `        <tr><th scope="row">${esc(name)}</th><td>${esc(sign)}</td><td>${esc(regions)}</td></tr>`,
  ).join('\n');
}

/** @param {string} tag */
function homeBody(tag) {
  return `    <section class="hero">
      <h1>JOY Media</h1>
      <p class="lead">A desktop video editor for Windows. The editor works offline, and your media stays on your PC.</p>
      <p><a class="button" href="/download">Download ${tag}</a></p>
      <p>Free and open source under the MIT License.</p>
    </section>
    <section aria-labelledby="features">
      <h2 id="features">What it does</h2>
      <ul>
        <li>Multi-track timeline editing with audio waveforms and motion titles.</li>
        <li>Works with no internet connection. The only network traffic is the AI provider you choose, and only when you use the agent.</li>
        <li>Bring your own AI keys, or sign in with a supported plan. Keys stay on this PC.</li>
      </ul>
    </section>
    <section aria-labelledby="shots">
      <h2 id="shots">Screenshots</h2>
      <p>Screenshots will be added before publication. The repository does not yet contain images of the desktop app.</p>
    </section>`;
}

const PROVIDERS_BODY = `    <h1>Providers</h1>
    <p>JOY Media connects to the AI providers you choose. You supply your own key or sign in with your own plan. Keys are stored on this PC, encrypted with Windows DPAPI. Nothing goes through a JOY server.</p>
    <table>
      <caption>Supported providers</caption>
      <thead>
        <tr><th scope="col">Provider</th><th scope="col">How to connect</th><th scope="col">Regions</th></tr>
      </thead>
      <tbody>
${providerRows()}
      </tbody>
    </table>
    <h2>ChatGPT sign-in is a preview</h2>
    <p>Sign-in with a ChatGPT plan is marked preview. Use an API key for providers that do not offer sign-in.</p>
    <h2>Local models</h2>
    <p>A model that runs on this computer can be used without a key. The app only accepts a local address that resolves to this computer.</p>`;

const PRIVACY_BODY = `    <h1>Privacy</h1>
    <ul>
      <li><strong>No account.</strong> JOY Media does not ask you to sign up.</li>
      <li><strong>No telemetry.</strong> The app does not report usage to anyone.</li>
      <li><strong>No JOY server.</strong> There is no JOY Media server in the path of your projects or keys.</li>
      <li><strong>Keys stay on this PC.</strong> Provider keys are encrypted with Windows DPAPI.</li>
      <li><strong>Only the provider you choose.</strong> Network traffic goes to the AI provider you select, and only when you use the agent.</li>
    </ul>
    <p>This website has no forms, cookies, analytics or sign-in.</p>`;

const SOURCE_BODY = `    <h1>Source and licence</h1>
    <p>JOY Media is free and open-source software under the <a href="${REPOSITORY_URL}/blob/main/LICENSE">MIT License</a>. Copyright (c) 2026 JOY Media contributors.</p>
    <ul>
      <li><a href="${REPOSITORY_URL}">Source code on GitHub</a></li>
      <li><a href="${REPOSITORY_URL}/blob/main/THIRD_PARTY_NOTICES.md">Third-party notices</a></li>
    </ul>`;

const NOT_FOUND_BODY = `    <h1>Page not found</h1>
    <p>There is nothing at this address. Try one of these pages:</p>
    <ul>
      <li><a href="/">Home</a></li>
      <li><a href="/download">Download</a></li>
    </ul>`;

const CSS = `:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #4a4a4a;
  --link: #0b5cad;
  --rule: #d0d0d0;
  --code-bg: #f3f3f3;
  --accent: #0b5cad;
  --accent-fg: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #121212;
    --fg: #ececec;
    --muted: #c4c4c4;
    --link: #8ab4f8;
    --rule: #3a3a3a;
    --code-bg: #1e1e1e;
    --accent: #8ab4f8;
    --accent-fg: #121212;
  }
}
:root[data-theme="dark"] {
  --bg: #121212;
  --fg: #ececec;
  --muted: #c4c4c4;
  --link: #8ab4f8;
  --rule: #3a3a3a;
  --code-bg: #1e1e1e;
  --accent: #8ab4f8;
  --accent-fg: #121212;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--link); }
.skip-link { position: absolute; left: -9999px; }
.skip-link:focus { left: 16px; top: 16px; background: var(--bg); padding: 8px; }
.site-header, main, .site-footer { max-width: 920px; margin: 0 auto; padding: 0 16px; }
.site-header { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; padding-top: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--rule); }
.brand { font-weight: 700; text-decoration: none; color: var(--fg); font-size: 1.1rem; }
.site-header ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 16px; }
main { padding-top: 24px; padding-bottom: 32px; }
h1 { font-size: 2rem; line-height: 1.2; }
h2 { font-size: 1.3rem; margin-top: 32px; }
table { width: 100%; border-collapse: collapse; margin: 16px 0; }
th, td { text-align: left; vertical-align: top; padding: 8px; border-bottom: 1px solid var(--rule); }
caption { text-align: left; font-weight: 600; padding-bottom: 8px; }
code, pre { font-family: ui-monospace, Consolas, "Courier New", monospace; font-size: 0.92rem; }
code { background: var(--code-bg); padding: 2px 4px; border-radius: 4px; overflow-wrap: anywhere; }
pre { background: var(--code-bg); padding: 12px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
.button { display: inline-block; background: var(--accent); color: var(--accent-fg); padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; }
.notice { border-left: 4px solid var(--accent); padding: 8px 12px; background: var(--code-bg); }
.site-footer { border-top: 1px solid var(--rule); padding-top: 16px; padding-bottom: 32px; color: var(--muted); font-size: 0.9rem; }
@media (max-width: 600px) {
  table, thead, tbody, tr, th, td { display: block; }
  thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  tr { border-bottom: 1px solid var(--rule); padding: 8px 0; }
  th, td { border: 0; padding: 4px 0; }
}
`;

/**
 * @param {{ tag: string, commit: string, sums?: Map<string, string> | null, sumsSha256?: string | null }} options
 * @returns {Record<string, string>} output path to contents
 */
export function renderSite({ tag, commit, sums = null, sumsSha256 = null }) {
  assertReleaseTag(tag);
  if (sums && !sumsSha256) {
    throw new Error('sumsSha256 must be given when sums are supplied');
  }
  const files = {
    'index.html': layout({ title: 'Home', active: '/', body: homeBody(tag) }),
    'download.html': layout({
      title: 'Download',
      active: '/download',
      body: downloadBody(tag, sums),
    }),
    'providers.html': layout({ title: 'Providers', active: '/providers', body: PROVIDERS_BODY }),
    'privacy.html': layout({ title: 'Privacy', active: '/privacy', body: PRIVACY_BODY }),
    'source.html': layout({ title: 'Source and licence', active: '/source', body: SOURCE_BODY }),
    '404.html': layout({ title: 'Page not found', body: NOT_FOUND_BODY }),
    'site.css': CSS,
    _headers: [
      '/*',
      "  Content-Security-Policy: default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      '  X-Content-Type-Options: nosniff',
      '  Referrer-Policy: strict-origin-when-cross-origin',
      '',
    ].join('\n'),
    'build.txt': [
      `site_commit=${commit}`,
      `release_tag=${tag}`,
      `hash_source=${sums ? 'SHA256SUMS.txt' : 'placeholder'}`,
      ...(sumsSha256 ? [`sha256sums_sha256=${sumsSha256}`] : []),
      '',
    ].join('\n'),
  };
  return files;
}
