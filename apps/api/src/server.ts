import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { LocalControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer } from './http-server.js';
import { DisabledMediaAuth, MediaAuthService } from './media-auth.js';
import { MediaMailer } from './media-mailer.js';
import { MediaTelegramSender } from './media-telegram.js';
import { PostgresControlPlane } from './postgres-control-plane.js';
import { RclonePrivateObjectStore } from './private-object-store.js';
import {
  createRuntimeMistralProviderRegistry,
  PostgresMistralInvocationLedger,
} from './mistral-provider.js';
import {
  MemorySpectralDenoiseInvocationLedger,
  PostgresSpectralDenoiseInvocationLedger,
  SpectralDenoiseService,
} from './spectral-denoise-service.js';
import { createClientAddressResolver, trustedProxyAddressesFromEnv } from './client-address.js';
import { productionReadinessOptions, releaseIdentityFromEnvironment } from './server-readiness.js';
import { instrumentPostgresPool } from './db-query-observability.js';
import { ResumableOriginalUploadCoordinator } from './resumable-original-upload.js';
import {
  createStockVideoCredentialSource,
  STOCK_VIDEO_SECRET_REFS,
} from './stock-video-credentials.js';
import { PexelsStockVideoProvider } from './pexels-stock-video-provider.js';
import { PixabayStockVideoProvider } from './pixabay-stock-video-provider.js';
import { PostgresStockVideoRepository, StockVideoService } from './stock-video.js';

await start();

async function start(): Promise<void> {
  const host = process.env.JOY_MEDIA_API_HOST ?? '127.0.0.1';
  const port = Number(process.env.JOY_MEDIA_API_PORT ?? 8790);
  const databaseUrl = process.env.JOY_MEDIA_DATABASE_URL;
  const rawPool =
    databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
  const pool = rawPool === undefined ? undefined : instrumentPostgresPool(rawPool);
  const durableControlPlane = pool === undefined ? undefined : new PostgresControlPlane(pool);
  if (durableControlPlane !== undefined) await durableControlPlane.initialize();
  const mistralLedger = pool === undefined ? undefined : new PostgresMistralInvocationLedger(pool);
  if (mistralLedger !== undefined) await mistralLedger.initialize();
  const audioDenoiseLedger =
    pool === undefined
      ? new MemorySpectralDenoiseInvocationLedger()
      : new PostgresSpectralDenoiseInvocationLedger(pool);
  if (audioDenoiseLedger instanceof PostgresSpectralDenoiseInvocationLedger)
    await audioDenoiseLedger.initialize();
  const controlPlane = durableControlPlane ?? new LocalControlPlane();
  const mailer = createMailer();
  const telegram = createTelegramSender();
  const clientAddressResolver = createClientAddressResolver({
    trustedProxyAddresses: trustedProxyAddressesFromEnv(),
  });
  const mediaAuth =
    pool === undefined
      ? new DisabledMediaAuth()
      : new MediaAuthService({
          pool,
          ...(mailer === undefined ? {} : { mailer }),
          ...(telegram === undefined ? {} : { telegram }),
          clientAddressResolver,
        });
  const privateObjectStore =
    process.env.JOY_MEDIA_OBJECT_STORE_REMOTE_PREFIX === undefined
      ? undefined
      : new RclonePrivateObjectStore({
          remotePrefix: process.env.JOY_MEDIA_OBJECT_STORE_REMOTE_PREFIX,
          ...(process.env.JOY_MEDIA_RCLONE_COMMAND === undefined
            ? {}
            : { command: process.env.JOY_MEDIA_RCLONE_COMMAND }),
        });
  const resumableOriginalUploads =
    privateObjectStore === undefined
      ? undefined
      : new ResumableOriginalUploadCoordinator({
          rootDirectory:
            process.env.JOY_MEDIA_UPLOAD_STAGING_DIR?.trim() ||
            '/opt/joy-media/data/upload-staging',
          controlPlane,
          privateObjectStore,
        });
  const stockVideoSecrets = createStockVideoCredentialSource((path, encoding) =>
    readFileSync(path, encoding),
  );
  const pexelsApiKey = stockVideoSecrets(STOCK_VIDEO_SECRET_REFS.pexels);
  const pixabayApiKey = stockVideoSecrets(STOCK_VIDEO_SECRET_REFS.pixabay);
  const stockVideoProviders = [
    ...(pexelsApiKey === undefined ? [] : [new PexelsStockVideoProvider({ apiKey: pexelsApiKey })]),
    ...(pixabayApiKey === undefined
      ? []
      : [new PixabayStockVideoProvider({ apiKey: pixabayApiKey })]),
  ];
  const stockVideo =
    pool !== undefined && privateObjectStore !== undefined && stockVideoProviders.length > 0
      ? new StockVideoService({
          repository: new PostgresStockVideoRepository(pool),
          providers: stockVideoProviders,
          controlPlane,
          privateObjectStore,
        })
      : undefined;
  createControlPlaneHttpServer({
    controlPlane,
    // Public /v1 (project/job/asset routes) stays disabled unless durable state
    // is configured; /v1/auth is served by mediaAuth regardless (it owns its
    // own allow-list/session tables independently of the control plane).
    authentication: {
      authenticate: (request) =>
        durableControlPlane === undefined ? undefined : mediaAuth.authenticate(request),
    },
    mediaAuth,
    clientAddressResolver,
    audioDenoise: new SpectralDenoiseService(audioDenoiseLedger),
    readiness: productionReadinessOptions({
      pool,
      durableControlPlane,
      privateObjectStore,
      releaseIdentity: releaseIdentityFromEnvironment(process.env),
    }),
    mistral: createRuntimeMistralProviderRegistry({
      ...(process.env.JOY_MEDIA_MISTRAL_API_KEY === undefined
        ? {}
        : { apiKey: process.env.JOY_MEDIA_MISTRAL_API_KEY }),
      ...(mistralLedger === undefined ? {} : { ledger: mistralLedger }),
    }),
    ...(privateObjectStore === undefined ? {} : { privateObjectStore }),
    ...(resumableOriginalUploads === undefined ? {} : { resumableOriginalUploads }),
    ...(stockVideo === undefined ? {} : { stockVideo }),
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
