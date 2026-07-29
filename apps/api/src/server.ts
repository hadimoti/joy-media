import { Pool } from 'pg';
import { LocalControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer } from './http-server.js';
import { DisabledMediaAuth, MediaAuthService } from './media-auth.js';
import { MediaMailer } from './media-mailer.js';
import { MediaTelegramSender } from './media-telegram.js';
import { PostgresControlPlane } from './postgres-control-plane.js';
import { RclonePrivateObjectStore } from './private-object-store.js';

await start();

async function start(): Promise<void> {
  const host = process.env.JOY_MEDIA_API_HOST ?? '127.0.0.1';
  const port = Number(process.env.JOY_MEDIA_API_PORT ?? 8790);
  const databaseUrl = process.env.JOY_MEDIA_DATABASE_URL;
  const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
  const durableControlPlane = pool === undefined ? undefined : new PostgresControlPlane(pool);
  if (durableControlPlane !== undefined) await durableControlPlane.initialize();
  const mailer = createMailer();
  const telegram = createTelegramSender();
  const mediaAuth =
    pool === undefined
      ? new DisabledMediaAuth()
      : new MediaAuthService({
          pool,
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
    ...(process.env.JOY_MEDIA_OBJECT_STORE_REMOTE_PREFIX === undefined
      ? {}
      : {
          privateObjectStore: new RclonePrivateObjectStore({
            remotePrefix: process.env.JOY_MEDIA_OBJECT_STORE_REMOTE_PREFIX,
            ...(process.env.JOY_MEDIA_RCLONE_COMMAND === undefined
              ? {}
              : { command: process.env.JOY_MEDIA_RCLONE_COMMAND }),
          }),
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
