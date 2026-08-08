/**
 * Hermes-style automatic asset tags for the catalog.
 * Always applies deterministic tags; optionally enriches via vision API when configured.
 */
export interface HermesTagInput {
  readonly kind: 'video' | 'audio' | 'image';
  readonly displayName: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  /** Optional image bytes for vision enrichment (images only). */
  readonly imageBytes?: Uint8Array;
}

export interface HermesTagResult {
  readonly tags: readonly string[];
  readonly sortName: string;
  readonly provenance: 'hermes-heuristic' | 'hermes-vision';
}

const MAX_TAGS = 24;
const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export async function tagAssetWithHermes(input: HermesTagInput): Promise<HermesTagResult> {
  const base = heuristicTags(input);
  const sortName = normalizeSortName(input.displayName);
  const visionUrl = process.env.JOY_MEDIA_HERMES_VISION_URL?.trim();
  if (
    visionUrl &&
    input.kind === 'image' &&
    input.imageBytes !== undefined &&
    input.imageBytes.byteLength > 0 &&
    input.imageBytes.byteLength <= 8 * 1024 * 1024
  ) {
    try {
      const visionTags = await visionTagsFromHermes(visionUrl, input);
      const merged = uniqueTags([...base, ...visionTags]);
      return { tags: merged, sortName, provenance: 'hermes-vision' };
    } catch {
      /* fall through to heuristic */
    }
  }
  return { tags: base, sortName, provenance: 'hermes-heuristic' };
}

export function heuristicTags(input: HermesTagInput): readonly string[] {
  const tags: string[] = ['hermes', input.kind];
  const mime = input.mimeType.toLowerCase();
  const subtype = mime.split('/')[1] ?? 'unknown';
  tags.push(`format-${sanitizeTag(subtype)}`);

  if (mime === 'image/gif' || mime === 'image/webp') tags.push('animated-candidate');
  if (mime.startsWith('image/')) tags.push('image');
  if (mime === 'image/png') tags.push('png');
  if (mime === 'image/jpeg' || mime === 'image/jpg') tags.push('photo');
  if (mime === 'image/gif') tags.push('gif');
  if (mime === 'image/webp') tags.push('webp');

  if (input.width !== undefined && input.height !== undefined) {
    const orient =
      input.width === input.height
        ? 'square'
        : input.width > input.height
          ? 'landscape'
          : 'portrait';
    tags.push(orient);
    if (input.width >= 1920 || input.height >= 1920) tags.push('hires');
  }

  if (input.bytes < 100_000) tags.push('tiny');
  else if (input.bytes < 2_000_000) tags.push('small');
  else if (input.bytes < 20_000_000) tags.push('medium');
  else tags.push('large');

  const name = input.displayName.toLocaleLowerCase();
  if (/[\u0600-\u06ff]/.test(input.displayName)) tags.push('fa');
  if (/\b(logo|icon|sticker)\b/i.test(name)) tags.push('graphic');
  if (/\b(screenshot|screen|capture)\b/i.test(name)) tags.push('screenshot');
  if (/\b(product|sku|ad)\b/i.test(name)) tags.push('product');

  const stem = name.replace(/\.[a-z0-9]+$/i, '');
  for (const token of stem.split(/[^a-z0-9\u0600-\u06ff]+/i)) {
    if (token.length >= 3 && token.length <= 24 && /^[a-z0-9]+$/i.test(token)) {
      tags.push(`name-${sanitizeTag(token)}`);
    }
  }

  return uniqueTags(tags).slice(0, MAX_TAGS);
}

export function normalizeSortName(displayName: string): string {
  return displayName
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 255);
}

export function sanitizeTag(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function uniqueTags(tags: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = sanitizeTag(raw);
    if (!TAG_RE.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

async function visionTagsFromHermes(
  visionUrl: string,
  input: HermesTagInput,
): Promise<readonly string[]> {
  const apiKey = process.env.JOY_MEDIA_HERMES_VISION_KEY?.trim() ?? '';
  const model = process.env.JOY_MEDIA_HERMES_VISION_MODEL?.trim() || 'gpt-4o-mini';
  const mime = input.mimeType;
  const b64 = Buffer.from(input.imageBytes!).toString('base64');
  const response = await fetch(visionUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Return 5-12 short lowercase English catalog tags for this image as a JSON array of strings only. Prefer subject, style, color, use-case.',
            },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`vision http ${response.status}`);
  const body = (await response.json()) as {
    readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
  };
  const content = body.choices?.[0]?.message?.content ?? '';
  const match = content.match(/\[[\s\S]*\]/);
  if (match === null) return [];
  const parsed = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is string => typeof item === 'string')
    .map((item) => sanitizeTag(item))
    .filter((item) => TAG_RE.test(item));
}
