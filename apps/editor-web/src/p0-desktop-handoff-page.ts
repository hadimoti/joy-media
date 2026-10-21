import { HtmlSceneSurfaceCache, type HtmlSceneProjectContext } from './html-scene-surfaces.js';

export interface P0DesktopHandoffFont {
  readonly family: string;
  readonly weight: 400 | 700;
  readonly subset: 'arabic' | 'latin';
  readonly bytesBase64: string;
}

export type P0DesktopHandoffOperation =
  | {
      readonly id: string;
      readonly kind: 'sync';
      readonly context: HtmlSceneProjectContext;
      readonly timeUs: number;
    }
  | {
      readonly id: string;
      readonly kind: 'capture';
      readonly context: HtmlSceneProjectContext;
      readonly timeUs: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly id: string;
      readonly kind: 'cancel';
      readonly context: HtmlSceneProjectContext;
      readonly timeUs: number;
      readonly width: number;
      readonly height: number;
    };

export interface P0DesktopHandoffRequest {
  readonly fonts: readonly P0DesktopHandoffFont[];
  readonly operations: readonly P0DesktopHandoffOperation[];
}

export interface P0DesktopHandoffSurface {
  readonly width: number;
  readonly height: number;
  readonly rgbaBase64: string;
}

export interface P0DesktopHandoffResult {
  readonly id: string;
  readonly surfaceIds: readonly string[];
  readonly surfaces: Readonly<Record<string, P0DesktopHandoffSurface>>;
  readonly metrics: ReturnType<HtmlSceneSurfaceCache['exportMetrics']>;
  readonly error?: string;
}

export interface P0DesktopHandoffResponse {
  readonly operations: readonly P0DesktopHandoffResult[];
  readonly cleanup: ReturnType<HtmlSceneSurfaceCache['exportMetrics']>;
}

declare global {
  interface Window {
    __joyP0DesktopHandoff?: (request: P0DesktopHandoffRequest) => Promise<P0DesktopHandoffResponse>;
  }
}

function toBase64(bytes: ArrayLike<number>): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const chunk: number[] = [];
    for (let index = start; index < Math.min(bytes.length, start + chunkSize); index += 1) {
      chunk.push(bytes[index] ?? 0);
    }
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function installFonts(fonts: readonly P0DesktopHandoffFont[]): Promise<void> {
  for (const font of fonts) {
    const face = await new FontFace(
      font.family,
      `url(data:font/woff2;base64,${font.bytesBase64})`,
      { weight: String(font.weight) },
    ).load();
    document.fonts.add(face);
  }
  await document.fonts.ready;
  for (const font of fonts) {
    if (!document.fonts.check(`${font.weight} 16px "${font.family}"`)) {
      throw new Error(`P0 title font failed browser readiness: ${font.subset} ${font.weight}`);
    }
  }
}

window.__joyP0DesktopHandoff = async (request) => {
  await installFonts(request.fonts);
  const cache = new HtmlSceneSurfaceCache();
  const results: P0DesktopHandoffResult[] = [];
  try {
    for (const operation of request.operations) {
      try {
        let surfaces: Record<string, P0DesktopHandoffSurface> = {};
        if (operation.kind === 'sync') {
          await cache.sync(operation.context, operation.timeUs);
        } else {
          const controller = new AbortController();
          if (operation.kind === 'cancel') controller.abort();
          const captured = await cache.captureFull(operation.context, operation.timeUs, {
            width: operation.width,
            height: operation.height,
            ...(operation.kind === 'cancel' ? { signal: controller.signal } : {}),
          });
          surfaces = Object.fromEntries(
            [...captured].map(([id, surface]) => [
              id,
              {
                width: surface.width,
                height: surface.height,
                rgbaBase64: toBase64(surface.data),
              },
            ]),
          );
        }
        results.push({
          id: operation.id,
          surfaceIds: [...cache.bitmaps().keys()],
          surfaces,
          metrics: cache.exportMetrics(),
        });
      } catch (error) {
        results.push({
          id: operation.id,
          surfaceIds: [...cache.bitmaps().keys()],
          surfaces: {},
          metrics: cache.exportMetrics(),
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }
  } finally {
    cache.destroy();
  }
  return { operations: results, cleanup: cache.exportMetrics() };
};
