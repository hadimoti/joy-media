import {
  classifyKeyCheck,
  modelsCatalogIssue,
  parseSmokeArgs,
  requestGateway,
} from './smoke-gateway-lib.mjs';

let options;
try {
  options = parseSmokeArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const prefix = 'Gateway';
const tls = { edgeAddr: options.edgeAddr, ca: options.caPath };
try {
  const root = options.baseUrl.replace(/\/+$/, '');
  const catalog = await requestGateway(
    root,
    '/models',
    { headers: { accept: 'application/json' } },
    options.host,
    tls,
  );
  if (catalog.status !== 200) {
    console.error(
      `${prefix}: expected unauthenticated GET /models to return 200; received ${catalog.status}.`,
    );
    process.exitCode = 1;
  } else {
    let catalogBody;
    try {
      catalogBody = await catalog.json();
    } catch {
      catalogBody = undefined;
    }
    const issue =
      catalogBody === undefined
        ? 'GET /models response is not valid JSON.'
        : modelsCatalogIssue(catalogBody);
    if (issue) {
      console.error(`${prefix}: ${issue}`);
      process.exitCode = 1;
    } else
      console.log(
        `${prefix}: unauthenticated GET /models returned 200 (the five free models only).`,
      );
  }

  const chat = await requestGateway(
    root,
    '/chat/completions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
    options.host,
    tls,
  );
  const keyIssue = await classifyKeyCheck(chat);
  if (keyIssue) {
    console.error(keyIssue);
    process.exitCode = 1;
  } else if (chat.status !== 401) {
    console.error(
      `${prefix}: expected unauthenticated POST /chat/completions to return 401; received ${chat.status}.`,
    );
    process.exitCode = 1;
  } else
    console.log(`${prefix}: unauthenticated POST /chat/completions returned 401; key configured.`);
} catch (error) {
  console.error(
    `${prefix} smoke failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
