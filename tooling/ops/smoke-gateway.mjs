const base = process.env.JOY_GATEWAY_BASE_URL ?? 'https://joyst.ir/api/v1/agent';
const root = base.replace(/\/+$/, '');
const catalog = await globalThis.fetch(`${root}/models`, {
  headers: { accept: 'application/json' },
});
if (catalog.status !== 200) {
  console.error(`Expected unauthenticated GET /models to return 200; received ${catalog.status}.`);
  process.exitCode = 1;
} else {
  console.log('Unauthenticated GET /models returned 200 as expected.');
}

const chat = await globalThis.fetch(`${root}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
if (chat.status !== 401) {
  console.error(
    `Expected unauthenticated POST /chat/completions to return 401; received ${chat.status}.`,
  );
  process.exitCode = 1;
} else {
  console.log('Unauthenticated POST /chat/completions returned 401 as expected.');
}
