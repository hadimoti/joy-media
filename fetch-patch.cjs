// fetch-patch.cjs
// Patch the global fetch to include a browser-like User-Agent to avoid Cloudflare challenges
const { fetch } = require('undici');
globalThis.fetch = (url, opts = {}) => {
  opts.headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    ...(opts.headers || {}),
  };
  return fetch(url, opts);
};
// Dynamically import the worker ES module
(async () => {
  await import('./apps/worker/dist/index.js');
})();
