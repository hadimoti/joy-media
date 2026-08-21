/**
 * Local Worker AI provider support for LM Studio, OpenRouter, Runway, and Higgsfield.
 * API keys are stored in ~/.joy-media/ai-providers.json on the Worker PC — never on the VPS.
 * ADR-0018 applies: all AI inference runs on the paired Worker, never the Media VPS.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export type AiProvider = 'lm-studio' | 'openrouter' | 'runway' | 'higgsfield';

export interface AiProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel: string;
}

export interface LocalAiReceipt {
  readonly kind: 'text' | 'image' | 'video';
  readonly jobId: string;
  readonly provider: AiProvider;
  readonly model?: string;
  readonly assetId?: string;
  readonly text?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly localRef?: string;
  readonly mimeType?: string;
  readonly descriptor?: {
    readonly mimeType: string;
    readonly width?: number;
    readonly height?: number;
  };
}

export interface LocalAiRunOptions {
  readonly jobId: string;
  readonly provider: AiProvider;
  readonly model: string;
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly imageAssetId?: string;
  readonly params?: Record<string, unknown>;
  readonly derivativeDirectory: string;
  readonly cancelled: () => boolean;
  readonly progress: (progress: number) => Promise<void>;
  readonly fetch?: typeof fetch;
}

const SECRETS_PATH = join(homedir(), '.joy-media', 'ai-providers.json');

export function loadAiProviderConfigs(): Record<string, AiProviderConfig> {
  if (!existsSync(SECRETS_PATH)) return {};
  try {
    const raw = readFileSync(SECRETS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: Record<string, AiProviderConfig> = {};
    for (const [key, val] of Object.entries(parsed)) {
      const v = val as Record<string, unknown>;
      if (
        typeof v.baseUrl === 'string' &&
        typeof v.apiKey === 'string' &&
        typeof v.defaultModel === 'string'
      ) {
        result[key] = { baseUrl: v.baseUrl, apiKey: v.apiKey, defaultModel: v.defaultModel };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function getConfiguredProviders(): readonly AiProvider[] {
  return Object.keys(loadAiProviderConfigs()) as AiProvider[];
}

function aiOutputUnavailable(message: string): never {
  throw new Error(`AI_OUTPUT_UNAVAILABLE: ${message}`);
}

function normalizeResponseMimeType(response: Response, fallbackMimeType: string): string {
  const header = response.headers.get('content-type');
  if (header === null) return fallbackMimeType;
  const mimeType = header.split(';', 1)[0]?.trim();
  return mimeType === undefined || mimeType.length === 0 ? fallbackMimeType : mimeType;
}

function pngDimensions(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  if (bytes.byteLength < 24) return undefined;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (const [index, value] of signature.entries()) {
    if (bytes[index] !== value) return undefined;
  }
  if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

export function descriptorForLocalAiOutput(
  kind: 'image' | 'video',
  mimeType: string,
  bytes: Uint8Array,
): NonNullable<LocalAiReceipt['descriptor']> {
  if (kind === 'video') {
    if (!mimeType.startsWith('video/')) {
      aiOutputUnavailable(`expected video output, received ${mimeType}`);
    }
    if (mimeType !== 'video/mp4') {
      aiOutputUnavailable(`unsupported video output ${mimeType}`);
    }
    return { mimeType };
  }
  if (!mimeType.startsWith('image/')) {
    aiOutputUnavailable(`expected image output, received ${mimeType}`);
  }
  if (mimeType === 'image/png') {
    const dimensions = pngDimensions(bytes);
    if (dimensions === undefined) {
      aiOutputUnavailable('PNG output dimensions are unavailable');
    }
    return { mimeType, ...dimensions };
  }
  aiOutputUnavailable(`unsupported image output ${mimeType}`);
}

async function runLmStudio(
  options: LocalAiRunOptions,
  config: AiProviderConfig,
  fetchFn: typeof fetch,
): Promise<LocalAiReceipt> {
  await options.progress(10);
  const body = {
    model: options.model || config.defaultModel,
    messages: [{ role: 'user', content: options.prompt }],
    max_tokens: (options.params?.maxTokens as number) ?? 2048,
    temperature: (options.params?.temperature as number) ?? 0.7,
  };
  if (options.cancelled()) throw new Error('canceled');
  const response = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`LM Studio error: ${response.status} ${await response.text()}`);
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content ?? '';
  await options.progress(100);
  return { kind: 'text', jobId: options.jobId, provider: 'lm-studio', text, model: body.model };
}

async function runOpenRouter(
  options: LocalAiRunOptions,
  config: AiProviderConfig,
  fetchFn: typeof fetch,
): Promise<LocalAiReceipt> {
  await options.progress(10);
  const body: Record<string, unknown> = {
    model: options.model || config.defaultModel,
    messages: [{ role: 'user', content: options.prompt }],
    max_tokens: (options.params?.maxTokens as number) ?? 4096,
    temperature: (options.params?.temperature as number) ?? 0.7,
  };
  if (options.cancelled()) throw new Error('canceled');
  const response = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'HTTP-Referer': 'https://joyst.ir',
      'X-Title': 'JOY Media',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`OpenRouter error: ${response.status} ${await response.text()}`);
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content ?? '';
  await options.progress(100);
  return {
    kind: 'text',
    jobId: options.jobId,
    provider: 'openrouter',
    text,
    model: String(body.model),
  };
}

async function runRunway(
  options: LocalAiRunOptions,
  config: AiProviderConfig,
  fetchFn: typeof fetch,
): Promise<LocalAiReceipt> {
  await options.progress(10);
  if (options.cancelled()) throw new Error('canceled');
  const taskBody: Record<string, unknown> = {
    model: options.model || config.defaultModel || 'gen-4',
    promptText: options.prompt,
  };
  if (options.negativePrompt) taskBody.negativePrompt = options.negativePrompt;
  if (options.params) taskBody.params = options.params;
  const createResponse = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(taskBody),
  });
  if (!createResponse.ok) throw new Error(`Runway task creation failed: ${createResponse.status}`);
  const createJson = (await createResponse.json()) as { id?: string };
  const taskId = createJson.id;
  if (!taskId) throw new Error('Runway task ID missing');
  await options.progress(30);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (options.cancelled()) throw new Error('canceled');
    const statusResponse = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!statusResponse.ok) throw new Error(`Runway status check failed: ${statusResponse.status}`);
    const statusJson = (await statusResponse.json()) as { status?: string; output?: unknown };
    if (statusJson.status === 'succeeded' && statusJson.output) {
      const videoUrl =
        typeof statusJson.output === 'string'
          ? statusJson.output
          : String((statusJson.output as Record<string, unknown>)?.url ?? '');
      if (!videoUrl) throw new Error('Runway succeeded but no output URL');
      await options.progress(70);
      const videoResponse = await fetchFn(videoUrl);
      if (!videoResponse.ok) throw new Error(`Runway output fetch failed: ${videoResponse.status}`);
      const arrayBuffer = await videoResponse.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const localRef = `ai-${options.jobId}-${sha256.slice(0, 16)}`;
      const mimeType = normalizeResponseMimeType(videoResponse, 'video/mp4');
      const descriptor = descriptorForLocalAiOutput('video', mimeType, bytes);
      mkdirSync(options.derivativeDirectory, { recursive: true });
      const outPath = join(options.derivativeDirectory, `${localRef}.mp4`);
      writeFileSync(outPath, Buffer.from(bytes));
      await options.progress(100);
      return {
        kind: 'video',
        jobId: options.jobId,
        provider: 'runway',
        sha256,
        bytes: bytes.length,
        localRef,
        mimeType,
        descriptor,
        model: options.model || 'gen-4',
      };
    }
    if (statusJson.status === 'failed')
      throw new Error(`Runway task failed: ${JSON.stringify(statusJson)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await options.progress(30 + attempt * 0.5);
  }
  throw new Error('Runway task timed out');
}

async function runHiggsfield(
  options: LocalAiRunOptions,
  config: AiProviderConfig,
  fetchFn: typeof fetch,
): Promise<LocalAiReceipt> {
  await options.progress(10);
  if (options.cancelled()) throw new Error('canceled');
  const body: Record<string, unknown> = {
    prompt: options.prompt,
    model: options.model || config.defaultModel || 'default',
  };
  if (options.negativePrompt) body.negative_prompt = options.negativePrompt;
  if (options.params) Object.assign(body, options.params);
  const response = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Higgsfield error: ${response.status} ${await response.text()}`);
  const text = await response.text();
  const json = JSON.parse(text) as {
    output?: { image?: string; video?: string };
    image?: string;
    video?: string;
  };
  const imageUrl = json.output?.image || json.image || '';
  const videoUrl = json.output?.video || json.video || '';
  if (imageUrl.length === 0 && videoUrl.length > 0) {
    aiOutputUnavailable('edit.higgsfield returned unsupported video output');
  }
  if (imageUrl.length === 0) throw new Error('Higgsfield returned no output');
  await options.progress(60);
  const mediaResponse = await fetchFn(imageUrl);
  if (!mediaResponse.ok) throw new Error(`Higgsfield output fetch failed: ${mediaResponse.status}`);
  const mediaArrayBuffer = await mediaResponse.arrayBuffer();
  const mediaBytes = Buffer.from(mediaArrayBuffer);
  const sha256 = createHash('sha256').update(mediaBytes).digest('hex');
  const localRef = `ai-${options.jobId}-${sha256.slice(0, 16)}`;
  const mimeType = normalizeResponseMimeType(mediaResponse, 'image/png');
  const descriptor = descriptorForLocalAiOutput('image', mimeType, mediaBytes);
  mkdirSync(options.derivativeDirectory, { recursive: true });
  const outPath = join(options.derivativeDirectory, `${localRef}.png`);
  writeFileSync(outPath, Buffer.from(mediaBytes));
  await options.progress(100);
  return {
    kind: 'image',
    jobId: options.jobId,
    provider: 'higgsfield',
    sha256,
    bytes: mediaBytes.length,
    localRef,
    mimeType,
    descriptor,
    model: options.model || 'default',
  };
}

export async function runAiJob(options: LocalAiRunOptions): Promise<LocalAiReceipt> {
  const configs = loadAiProviderConfigs();
  const config = configs[options.provider];
  if (!config)
    throw new Error(
      `AI provider "${options.provider}" is not configured. Create ~/.joy-media/ai-providers.json`,
    );
  const fetchFn = options.fetch ?? fetch;
  switch (options.provider) {
    case 'lm-studio':
      return runLmStudio(options, config, fetchFn);
    case 'openrouter':
      return runOpenRouter(options, config, fetchFn);
    case 'runway':
      return runRunway(options, config, fetchFn);
    case 'higgsfield':
      return runHiggsfield(options, config, fetchFn);
    default:
      throw new Error(`Unknown AI provider: ${options.provider}`);
  }
}
