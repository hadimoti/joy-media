import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { LocalControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer } from './http-server.js';
import { DisabledMediaAuth, MediaAuthService } from './media-auth.js';
import { isValidSmtpHostname, MediaMailer } from './media-mailer.js';
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
import {
  createEd25519EntitlementSigner,
  DisabledEntitlementSigner,
  readEntitlementSigningKeyFromCredential,
} from './entitlement-signing.js';
import { AccountService, DisabledAccountService } from './account-service.js';
import {
  DisabledReleaseMetadataService,
  ReleaseMetadataService,
} from './release-metadata-service.js';
import { readHostedRouteRetirementFlags } from './hosted-route-retirement.js';
import { JoyModelGateway, readOpenRouterApiKeyFromCredential } from './joy-model-gateway.js';
import { MemoryAgentUsageLedger, PostgresAgentUsageLedger } from './agent-usage-ledger.js';
import { readLegacyEditorRetired } from './legacy-editor-retirement.js';
import {
  AlchemyJsonRpcTransport,
  readAlchemyRpcUrlFromCredential,
  readAlchemyWebhookSigningKeyFromCredential,
} from './alchemy-transport.js';
import { UsdcInvoiceLedger } from './usdc-invoice-ledger.js';
import { DisabledUsdcCheckoutService, UsdcCheckoutService } from './usdc-checkout-service.js';

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
  if (mailer === undefined)
    console.warn('JOY Media OTP email is unavailable: SMTP is not configured.');
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
  // Never generated, never committed, never logged — read only from the systemd
  // LoadCredential= file the owner/Codex provisions out-of-band (wave 4). Absent ->
  // DisabledEntitlementSigner, same "feature reads as unconfigured, process still starts"
  // shape as mediaAuth/mailer/telegram above.
  const entitlementSigningKey = readEntitlementSigningKeyFromCredential((path, encoding) =>
    readFileSync(path, encoding),
  );
  const entitlementSigner =
    entitlementSigningKey === undefined
      ? new DisabledEntitlementSigner()
      : createEd25519EntitlementSigner(entitlementSigningKey);
  const account =
    pool === undefined
      ? new DisabledAccountService()
      : new AccountService({ pool, signer: entitlementSigner });
  const releases =
    pool === undefined
      ? new DisabledReleaseMetadataService()
      : new ReleaseMetadataService({ pool });
  // Every flag defaults false; this deployment's actual environment does not set any of
  // them, so this line changes nothing about today's routing (wave 4/6 - see
  // hosted-route-retirement.ts's module doc).
  const hostedRouteRetirement = readHostedRouteRetirementFlags(process.env);
  // Coarser kill switch (wave 6) — false in this deployment's actual environment today.
  const legacyEditorRetired = readLegacyEditorRetired(process.env);

  // USDC checkout (wave 5). Every one of these five conditions is unset in this deployment's
  // actual environment today, so `usdcCheckout` always resolves to the Disabled fallback here
  // — see usdc-checkout-service.ts's module doc on the "keep checkout disabled until the
  // live-wallet test gate is recorded" locked decision. The recipient/contract addresses are
  // never hardcoded or defaulted: they must come from JOY_MEDIA_USDC_RECIPIENT_ADDRESS /
  // JOY_MEDIA_USDC_CONTRACT_ADDRESS only after the owner's protected verification of deployed
  // configuration.
  const alchemyRpcUrl = readAlchemyRpcUrlFromCredential((path, encoding) =>
    readFileSync(path, encoding),
  );
  const alchemyWebhookSigningKey = readAlchemyWebhookSigningKeyFromCredential((path, encoding) =>
    readFileSync(path, encoding),
  );
  const usdcRecipientAddress = process.env.JOY_MEDIA_USDC_RECIPIENT_ADDRESS;
  const usdcContractAddress = process.env.JOY_MEDIA_USDC_CONTRACT_ADDRESS;
  const usdcChainId = Number(process.env.JOY_MEDIA_USDC_CHAIN_ID ?? '1');
  const usdcCheckout =
    pool === undefined ||
    alchemyRpcUrl === undefined ||
    alchemyWebhookSigningKey === undefined ||
    usdcRecipientAddress === undefined ||
    usdcContractAddress === undefined
      ? new DisabledUsdcCheckoutService()
      : new UsdcCheckoutService({
          ledger: new UsdcInvoiceLedger({
            pool,
            recipientAddress: usdcRecipientAddress,
            contractAddress: usdcContractAddress,
            chainId: usdcChainId,
          }),
          account,
          transport: new AlchemyJsonRpcTransport({ rpcUrl: alchemyRpcUrl }),
          webhookSigningKey: alchemyWebhookSigningKey,
          // Also gated independently: even with everything else configured, checkout stays
          // off unless this is explicitly "true" (the live-wallet test gate).
          checkoutEnabled: process.env.JOY_MEDIA_USDC_CHECKOUT_ENABLED === 'true',
          policy: {
            requiredConfirmations: Number(
              process.env.JOY_MEDIA_USDC_REQUIRED_CONFIRMATIONS ?? '12',
            ),
            expectedChainId: usdcChainId,
            expectedContractAddress: usdcContractAddress,
            expectedRecipientAddress: usdcRecipientAddress,
          },
        });

  const envOpenRouterApiKey = process.env.JOY_MEDIA_OPENROUTER_API_KEY?.trim() || undefined;
  let credentialId: string | undefined;
  const credentialOpenRouterApiKey = readOpenRouterApiKeyFromCredential((path, encoding) => {
    credentialId = path.slice(path.lastIndexOf('/') + 1);
    return readFileSync(path, encoding);
  });
  const openRouterApiKey = envOpenRouterApiKey ?? credentialOpenRouterApiKey;
  const credentialSource =
    envOpenRouterApiKey !== undefined
      ? 'env'
      : credentialOpenRouterApiKey !== undefined && credentialId !== undefined
        ? `credential:${credentialId}`
        : 'none';
  console.info(
    `joy-model-gateway: configured=${openRouterApiKey !== undefined} source=${credentialSource}`,
  );
  const agentUsageLedger =
    pool === undefined ? new MemoryAgentUsageLedger() : new PostgresAgentUsageLedger(pool);
  const joyModelGateway = new JoyModelGateway({
    mediaAuth,
    account,
    ledger: agentUsageLedger,
    openRouterApiKey,
  });

  createControlPlaneHttpServer({
    controlPlane,
    // Public /v1 (project/job/asset routes) stays disabled unless durable state
    // is configured; /v1/auth is served by mediaAuth regardless (it owns its
    // own allow-list/session tables independently of the control plane).
    // `legacyEditorRetired` is wave 6's coarser kill switch (see
    // legacy-editor-retirement.ts) — false in this deployment's actual environment today, so
    // this line changes nothing about current routing.
    authentication: {
      authenticate: (request) =>
        legacyEditorRetired || durableControlPlane === undefined
          ? undefined
          : mediaAuth.authenticate(request),
    },
    mediaAuth,
    account,
    releases,
    entitlementPublicKeyPem: entitlementSigner.publicKeyPem,
    hostedRouteRetirement,
    usdcCheckout,
    joyModelGateway,
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
  const configuredFamily = process.env.JOY_MEDIA_SMTP_FAMILY?.trim().toLowerCase();
  const family = ['4', '6', 'auto'].includes(configuredFamily ?? '')
    ? (configuredFamily as '4' | '6' | 'auto')
    : '4';
  if (configuredFamily && family !== configuredFamily)
    console.warn('Invalid JOY_MEDIA_SMTP_FAMILY; using IPv4 (4).');
  const rawEhloName = process.env.JOY_MEDIA_SMTP_EHLO_NAME?.trim() || 'joyst.ir';
  const ehloName = isValidSmtpHostname(rawEhloName) ? rawEhloName : 'joyst.ir';
  if (ehloName !== rawEhloName) console.warn('Invalid JOY_MEDIA_SMTP_EHLO_NAME; using joyst.ir.');
  if (
    host === undefined ||
    port === undefined ||
    user === undefined ||
    pass === undefined ||
    from === undefined
  )
    return undefined;
  return new MediaMailer({
    host,
    port: Number(port),
    user,
    pass,
    from,
    family,
    ehloName,
    onOtpDeliveryFailure: (metadata) => console.error('JOY Media OTP delivery failed', metadata),
  });
}

function createTelegramSender(): MediaTelegramSender | undefined {
  const botToken = process.env.JOY_MEDIA_BOT_TOKEN;
  return botToken === undefined ? undefined : new MediaTelegramSender({ botToken });
}
