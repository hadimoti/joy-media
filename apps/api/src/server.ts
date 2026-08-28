import { Pool } from 'pg';
import { LocalControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer } from './http-server.js';
import { DisabledMediaAuth, MediaAuthService, mediaAuthHashKeysForDatabase } from './media-auth.js';
import { MediaMailer } from './media-mailer.js';
import { MediaTelegramSender } from './media-telegram.js';
import { PostgresControlPlane } from './postgres-control-plane.js';
import { RclonePrivateObjectStore } from './private-object-store.js';
import {
  createRuntimeMistralProviderRegistry,
  PostgresMistralInvocationLedger,
} from './mistral-provider.js';
import {
  PostgresProviderApprovalStore,
  ProviderApprovalService,
  providerApprovalSigningConfigFromEnv,
} from './provider-approval.js';
import { productionReadinessOptions } from './server-readiness.js';

await start();

async function start(): Promise<void> {
  const host = process.env.JOY_MEDIA_API_HOST ?? '127.0.0.1';
  const port = Number(process.env.JOY_MEDIA_API_PORT ?? 8790);
  const databaseUrl = process.env.JOY_MEDIA_DATABASE_URL;
  const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
  const privateObjectStore =
    process.env.JOY_MEDIA_OBJECT_STORE_REMOTE_PREFIX === undefined
      ? undefined
      : new RclonePrivateObjectStore({
          remotePrefix: process.env.JOY_MEDIA_OBJECT_STORE_REMOTE_PREFIX,
          ...(process.env.JOY_MEDIA_RCLONE_COMMAND === undefined
            ? {}
            : { command: process.env.JOY_MEDIA_RCLONE_COMMAND }),
        });
  const durableControlPlane =
    pool === undefined
      ? undefined
      : new PostgresControlPlane(
          pool,
          privateObjectStore === undefined ? {} : { privateObjectStore },
        );
  if (durableControlPlane !== undefined) await durableControlPlane.initialize();
  const mistralLedger = pool === undefined ? undefined : new PostgresMistralInvocationLedger(pool);
  if (mistralLedger !== undefined) await mistralLedger.initialize();
  const providerApprovalStore =
    pool === undefined ? undefined : new PostgresProviderApprovalStore(pool);
  if (providerApprovalStore !== undefined) await providerApprovalStore.initialize();
  // Production server construction is explicit about missing configuration so
  // approval-required provider paths fail closed instead of generating a
  // process-local signing key.
  const providerApprovals = new ProviderApprovalService(
    providerApprovalStore,
    undefined,
    providerApprovalSigningConfigFromEnv(),
  );
  const mailer = createMailer();
  const telegram = createTelegramSender();
  const mediaAuthHashKeys = mediaAuthHashKeysForDatabase(databaseUrl);
  const mediaAuth =
    pool === undefined
      ? new DisabledMediaAuth()
      : new MediaAuthService({
          pool,
          ...(mediaAuthHashKeys === undefined ? {} : { hashKeys: mediaAuthHashKeys }),
          ...(mailer === undefined ? {} : { mailer }),
          ...(telegram === undefined ? {} : { telegram }),
        });
  createControlPlaneHttpServer({
    controlPlane: durableControlPlane ?? new LocalControlPlane(),
    // Public /v1 (project/job/asset routes) stays disabled unless durable state
    // is configured; /v1/auth is served by mediaAuth regardless (it owns its
    // own allow-list/session tables independently of the control plane).
    authentication: {
      authenticate: (request) =>
        durableControlPlane === undefined ? undefined : mediaAuth.authenticate(request),
    },
    mediaAuth,
    providerApprovals,
    mistral: createRuntimeMistralProviderRegistry({
      ...(process.env.JOY_MEDIA_MISTRAL_API_KEY === undefined
        ? {}
        : { apiKey: process.env.JOY_MEDIA_MISTRAL_API_KEY }),
      ...(mistralLedger === undefined ? {} : { ledger: mistralLedger }),
      approvals: providerApprovals,
    }),
    ...(privateObjectStore === undefined ? {} : { privateObjectStore }),
    readiness: productionReadinessOptions({
      pool,
      durableControlPlane,
      privateObjectStore,
    }),
  }).listen(port, host);
  console.log(`JOY Media API listening on ${host}:${port}`);
}

function createMailer(): MediaMailer | undefined {
  const host = process.env.JOY_MEDIA_SMTP_HOST;
  const port = process.env.JOY_MEDIA_SMTP_PORT;
  const user = process.env.JOY_MEDIA_SMTP_USER;
  const pass = process.env.JOY_MEDIA_SMTP_PASS;
  const from = process.env.JOY_MEDIA_SMTP_FROM;
  if (
    host === undefined ||
    port === undefined ||
    user === undefined ||
    pass === undefined ||
    from === undefined
  )
    return undefined;
  return new MediaMailer({ host, port: Number(port), user, pass, from });
}

function createTelegramSender(): MediaTelegramSender | undefined {
  const botToken = process.env.JOY_MEDIA_BOT_TOKEN;
  return botToken === undefined ? undefined : new MediaTelegramSender({ botToken });
}
