const base = process.env.JOY_GATEWAY_BASE_URL ?? 'https://joyst.ir/api/v1/agent';
const response = await globalThis.fetch(`${base.replace(/\/+$/, '')}/models`, {
  headers: { accept: 'application/json' },
});
if (response.status !== 401) {
  console.error(`Expected unauthenticated GET /models to return 401; received ${response.status}.`);
  process.exitCode = 1;
} else {
  console.log('Unauthenticated GET /models returned 401 as expected.');
}
