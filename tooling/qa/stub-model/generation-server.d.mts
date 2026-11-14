/** Types for the fake MiniMax generation server (generation-server.mjs), read by the desktop integration suite. */

export const GENERATION_ROUTES: readonly [
  'image',
  'image-legacy',
  'video-create',
  'video-create-legacy',
  'video-query',
  'video-query-legacy',
  'video-cancel',
  'file-link',
  'download',
];

export type GenerationRouteLabel = (typeof GENERATION_ROUTES)[number];

export const FAKE_MEDIA_HOST: string;

/** One scripted reply. `drop` closes the connection; `body`, `contentLength` and `dropAfterBytes` shape a download. */
export interface ScriptedReply {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly drop?: boolean;
  readonly body?: Uint8Array;
  readonly contentLength?: number;
  readonly dropAfterBytes?: number;
}

export interface LoggedRequest {
  readonly label: GenerationRouteLabel | 'unknown';
  readonly method: string;
  readonly path: string;
  readonly search: string;
  /** Whether the bearer key was the expected one. The key itself is never logged. */
  readonly authorizationOk: boolean;
  readonly body: unknown;
}

export interface GenerationServer {
  readonly origin: string;
  readonly requests: readonly LoggedRequest[];
  reply(label: GenerationRouteLabel, ...replies: readonly ScriptedReply[]): void;
  pending(label: GenerationRouteLabel): number;
  close(): Promise<void>;
}

export function reply(spec: ScriptedReply): ScriptedReply;

export function startGenerationServer(options: {
  readonly expectedKey: string;
  readonly port?: number;
}): Promise<GenerationServer>;
