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

/** Links in the page header. Everything else is in the footer. */
export const NAV = [
  ['/download', 'Download'],
  [REPOSITORY_URL, 'GitHub'],
];

/** Links in the footer. */
const FOOTER_NAV = [
  ['/providers', 'Providers'],
  ['/privacy', 'Privacy'],
  ['/source', 'Source and licence'],
  [`${REPOSITORY_URL}/releases`, 'Older releases'],
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
 * @param {{ title: string, active?: string, body: string, wide?: boolean }} options
 * @returns {string} a complete HTML document
 */
function layout({ title, active, body, wide = false }) {
  const nav = NAV.map(
    ([href, label]) =>
      `        <li><a href="${href}"${href === active ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`,
  ).join('\n');
  const footerNav = FOOTER_NAV.map(
    ([href, label]) => `        <li><a href="${href}">${esc(label)}</a></li>`,
  ).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} | JOY Media</title>
  <meta name="description" content="JOY Media is a free, open-source video editor for Windows. No account, no upload: your media stays on your PC.">
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
  <main id="main"${wide ? ' class="wide"' : ''}>
${body}
  </main>
  <footer class="site-footer">
    <nav aria-label="Footer">
      <ul>
${footerNav}
      </ul>
    </nav>
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
  const [installer, zip] = payloadNames(tag);
  const note = sums
    ? ''
    : `
      <p class="notice" role="status">Checksums for ${tag} are not published yet. The hash cells are placeholders and must not be trusted.</p>`;
  return `    <h1>Download JOY Media</h1>
    <p class="lead">Version <strong>${tag}</strong> for Windows x64. Free, with no account.</p>${note}
    <div class="cards">
      <section class="card card-primary" aria-labelledby="installer">
        <h2 id="installer">Installer <span class="tag">recommended</span></h2>
        <p>Installs JOY Media for your Windows user, adds Desktop and Start Menu shortcuts and puts the <code>joy</code> command on your PATH. Your projects and settings stay when you uninstall.</p>
        <p><a class="button" href="${downloadUrl(tag, installer)}">Download ${esc(installer)}</a></p>
        <p class="small">About 200 MB.</p>
      </section>
      <section class="card" aria-labelledby="portable">
        <h2 id="portable">Portable zip</h2>
        <p>No install. Unzip it anywhere and run <code>joy-media.exe</code>.</p>
        <p><a class="button button-quiet" href="${downloadUrl(tag, zip)}">Download ${esc(zip)}</a></p>
        <p class="small">About 200 MB.</p>
      </section>
    </div>

    <section class="callout" aria-labelledby="signing">
      <h2 id="signing">These files are not code-signed</h2>
      <p>Windows SmartScreen will warn you when you run them, because the files are not signed. Check your download first. Open PowerShell in the folder that holds it and run:</p>
      <pre><code>Get-FileHash .\\${installer} -Algorithm SHA256</code></pre>
      <p>Continue only if the result matches the SHA-256 value for that file in the table below.</p>
    </section>

    <h2>All files and their SHA-256</h2>
    <table>
      <caption>Files in ${tag}</caption>
      <thead>
        <tr><th scope="col">File</th><th scope="col">SHA-256</th><th scope="col">Link</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>

    <h2>Good to know</h2>
    <ul>
      <li>JOY Media does not update itself. Return to this page for newer versions.</li>
      <li>The installer, the zip and <code>joy-media.exe</code> are the app. <code>joy-worker.exe</code>, the bundle and the manifest are for the command line and for checking the release.</li>
      <li>Earlier versions are on the <a href="${REPOSITORY_URL}/releases">GitHub releases page</a>.</li>
    </ul>`;
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
      <h1>A free video editor for Windows that stays on your PC.</h1>
      <p class="lead">No account. No upload. Open source.</p>
      <p class="actions">
        <a class="button" href="/download">Download for Windows (${tag})</a>
        <a class="button button-quiet" href="${REPOSITORY_URL}">View source on GitHub</a>
      </p>
      <p class="small">Windows x64. Free under the MIT License.</p>
      <img class="shot shot-hero" src="/img/hero.png" width="2000" height="1082" alt="The JOY Media editor: media on the left, a large preview in the middle, motion presets on the right, and the timeline below.">
    </section>

    <section class="feature" aria-labelledby="timeline">
      <div class="feature-text">
        <h2 id="timeline">Cut on a real timeline</h2>
        <p>Stack clips on video and audio tracks. Trim, split and zoom along a ruler you can read, and see your whole edit at a glance.</p>
      </div>
      <img class="shot" src="/img/timeline.png" width="1600" height="228" alt="The timeline with three clips on a video track, a ruler, and the editing toolbar above it.">
    </section>

    <section class="feature feature-split" aria-labelledby="control">
      <div class="feature-text">
        <h2 id="control">Fine control when you want it</h2>
        <p>Set position, scale, rotation and opacity for every clip, and animate any of them with keyframes. Effects, Mask, Enhance and Speed sit in tabs right next to it.</p>
      </div>
      <img class="shot" src="/img/inspector.png" width="983" height="1076" alt="The Inspector panel with the Visual, Enhance, Mask, Effects, Audio and Speed tabs and the transform controls.">
    </section>

    <section class="feature feature-pair" aria-labelledby="titles">
      <div class="feature-text">
        <h2 id="titles">Titles and motion built in</h2>
        <p>Start from a title template, then add a motion preset such as Fade In, Pop or Slide. No plug-ins to hunt for.</p>
      </div>
      <img class="shot" src="/img/titles.png" width="979" height="558" alt="Title templates: Clean Title, Bold Stack, Cinematic Wide and more.">
      <img class="shot" src="/img/motion.png" width="1056" height="1086" alt="Built-in motion presets such as Fade In, Fade Out, Pop In, Zoom In and Slide Up.">
    </section>

    <section class="feature feature-plain" aria-labelledby="ai">
      <h2 id="ai">Bring your own AI, or use none</h2>
      <p>The editor works with no internet connection. Joy Code, the optional assistant, uses a model that you connect yourself: an API key, or a sign-in with a supported plan. Your keys stay on this PC and nothing goes through a JOY server. <a href="/providers">See the providers</a> and the <a href="/privacy">privacy facts</a>.</p>
    </section>

    <section class="callout" aria-labelledby="start">
      <h2 id="start">Get JOY Media ${tag}</h2>
      <p>The files are not code-signed, so Windows will warn you. The download page shows how to check them.</p>
      <p><a class="button" href="/download">Go to the download page</a></p>
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
  color-scheme: dark;
  --bg: #0c0c0e;
  --panel: #1a1b1e;
  --elevated: #222327;
  --inset: #131416;
  --rule: #2f3036;
  --fg: #e9e9ed;
  --muted: #a9abb4;
  --faint: #7d7f89;
  --link: #f4b72f;
  --accent: #f4b72f;
  --accent-fg: #14120a;
  --radius: 8px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.65 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--link); text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible, .button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.skip-link { position: absolute; left: -9999px; }
.skip-link:focus { left: 16px; top: 16px; background: var(--panel); padding: 8px 12px; border-radius: var(--radius); }
.site-header, main, .site-footer { max-width: 1080px; margin: 0 auto; padding-left: 24px; padding-right: 24px; }
.site-header { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; justify-content: space-between; padding-top: 20px; padding-bottom: 20px; }
.brand { font-weight: 700; text-decoration: none; color: var(--fg); font-size: 1.15rem; letter-spacing: 0.01em; }
.site-header ul, .site-footer ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 24px; }
.site-header a { color: var(--muted); text-decoration: none; }
.site-header a:hover, .site-header a[aria-current] { color: var(--fg); }
main { padding-top: 24px; padding-bottom: 48px; }
h1 { font-size: clamp(2rem, 4.5vw, 3.1rem); line-height: 1.12; letter-spacing: -0.02em; margin: 0 0 16px; }
h2 { font-size: 1.5rem; line-height: 1.25; margin: 40px 0 12px; letter-spacing: -0.01em; }
p { margin: 0 0 16px; }
.lead { font-size: 1.2rem; color: var(--muted); }
.small { font-size: 0.9rem; color: var(--faint); }
.hero { text-align: center; padding-top: 24px; }
.hero h1 { max-width: 18ch; margin-left: auto; margin-right: auto; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin: 28px 0 12px; }
.button { display: inline-block; background: var(--accent); color: var(--accent-fg); padding: 12px 22px; border-radius: var(--radius); text-decoration: none; font-weight: 600; border: 1px solid var(--accent); }
.button:hover { filter: brightness(1.08); }
.button-quiet { background: transparent; color: var(--fg); border-color: var(--rule); }
.button-quiet:hover { border-color: var(--muted); filter: none; }
.shot { display: block; max-width: 100%; height: auto; border: 1px solid var(--rule); border-radius: var(--radius); box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55); background: var(--inset); }
.shot-hero { margin: 40px auto 0; }
.feature { margin-top: 72px; }
.feature .shot { margin-top: 24px; }
.feature-text { max-width: 56ch; }
.feature-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 360px); gap: 8px 48px; align-items: center; }
.feature-split .feature-text { grid-column: 1; grid-row: 1; }
.feature-split .shot { grid-column: 2; grid-row: 1; margin-top: 0; }
.feature-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; align-items: start; }
.feature-pair .feature-text { grid-column: 1 / -1; }
.feature-pair .shot { margin-top: 0; }
.feature-plain { max-width: 66ch; }
.callout { margin-top: 72px; padding: 24px; background: var(--panel); border: 1px solid var(--rule); border-radius: var(--radius); }
.callout h2 { margin-top: 0; font-size: 1.25rem; }
.callout p:last-child { margin-bottom: 0; }
.cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin: 32px 0; }
.card { padding: 24px; background: var(--panel); border: 1px solid var(--rule); border-radius: var(--radius); }
.card h2 { margin-top: 0; font-size: 1.3rem; }
.card-primary { border-color: var(--accent); }
.tag { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent); margin-left: 8px; }
table { width: 100%; border-collapse: collapse; margin: 16px 0; }
th, td { text-align: left; vertical-align: top; padding: 10px 8px; border-bottom: 1px solid var(--rule); }
caption { text-align: left; font-weight: 600; padding-bottom: 8px; color: var(--muted); }
code, pre { font-family: ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace; font-size: 0.9rem; }
code { background: var(--inset); padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere; }
pre { background: var(--inset); padding: 14px 16px; border-radius: var(--radius); overflow-x: auto; border: 1px solid var(--rule); }
pre code { background: none; padding: 0; }
.notice { border-left: 4px solid var(--accent); padding: 8px 12px; background: var(--panel); }
.site-footer { border-top: 1px solid var(--rule); padding-top: 24px; padding-bottom: 40px; color: var(--faint); font-size: 0.9rem; }
.site-footer a { color: var(--muted); }
.site-footer nav { margin-bottom: 12px; }
@media (max-width: 760px) {
  .feature-split, .feature-pair, .cards { grid-template-columns: minmax(0, 1fr); }
  .feature-split .feature-text, .feature-split .shot { grid-column: 1; grid-row: auto; }
  .feature-split .shot { margin-top: 24px; max-width: 360px; }
  .feature { margin-top: 48px; }
}
@media (max-width: 600px) {
  .site-header, main, .site-footer { padding-left: 16px; padding-right: 16px; }
  table, thead, tbody, tr, th, td { display: block; }
  thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  tr { border-bottom: 1px solid var(--rule); padding: 8px 0; }
  th, td { border: 0; padding: 4px 0; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
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
