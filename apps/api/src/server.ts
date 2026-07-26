import { Pool } from 'pg';
import { LocalControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer } from './http-server.js';
import { JoyIdentityVerifier } from './joy-identity.js';
import { PostgresControlPlane } from './postgres-control-plane.js';
import { RclonePrivateObjectStore } from './private-object-store.js';

await start();

async function start(): Promise<void> {
  const host = process.env.JOY_MEDIA_API_HOST ?? '127.0.0.1';
  const port = Number(process.env.JOY_MEDIA_API_PORT ?? 8790);
  const databaseUrl = process.env.JOY_MEDIA_DATABASE_URL;
  const identity = createIdentityVerifier();
  const durableControlPlane =
    databaseUrl === undefined
      ? undefined
      : new PostgresControlPlane(new Pool({ connectionString: databaseUrl }));
  if (durableControlPlane !== undefined) await durableControlPlane.initialize();
  createControlPlaneHttpServer({
    controlPlane: durableControlPlane ?? new LocalControlPlane(),
    authentication: {
      // Public /v1 stays disabled unless both the JOY verifier and durable
      // state are configured. Health remains intentionally public.
      authenticate: (request) =>
        identity === undefined || durableControlPlane === undefined
          ? undefined
          : identity.authenticate(request),
    },
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

function createIdentityVerifier(): JoyIdentityVerifier | undefined {
  const issuer = process.env.JOY_MEDIA_IDENTITY_ISSUER;
  const audience = process.env.JOY_MEDIA_IDENTITY_AUDIENCE;
  const jwksUrl = process.env.JOY_MEDIA_IDENTITY_JWKS_URL;
  if (issuer === undefined || audience === undefined || jwksUrl === undefined) return undefined;
  return new JoyIdentityVerifier({ issuer, audience, jwksUrl });
}
