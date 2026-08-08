/**
 * PSD Parser Spike — evaluates ag-psd for the Templates PSD import feature.
 *
 * ag-psd is MIT-licensed, pure JavaScript (no WASM), works in browsers.
 * API: readPsd(ArrayBuffer, ReadOptions?) -> Psd
 *
 * Installed: pnpm --filter @joy-media/editor-web add ag-psd
 */

export interface PsdLayerDto {
  readonly id: string;
  readonly name: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly opacity: number;
  readonly visible: boolean;
  readonly type: 'raster' | 'text' | 'group' | 'adjustment' | 'smart-object' | 'unknown';
  readonly imageBlobId?: string;
  readonly text?: string;
}

export interface PsdParseResult {
  readonly layers: readonly PsdLayerDto[];
  readonly width: number;
  readonly height: number;
  readonly parseTimeMs: number;
}

interface AgPsdLayer {
  readonly top?: number;
  readonly left?: number;
  readonly bottom?: number;
  readonly right?: number;
  readonly opacity?: number;
  readonly hidden?: boolean;
  readonly name?: string;
  readonly id?: number;
  readonly canvas?: unknown;
  readonly imageData?: unknown;
  readonly children?: AgPsdLayer[];
  readonly text?: { readonly text?: string };
  readonly adjustment?: unknown;
  readonly placedLayer?: unknown;
}

/**
 * Parse a PSD file and extract layers.
 *
 * Two-phase parse:
 * Phase 1 (structure-only, ~50-150ms): DoS-hardened dimension check using
 *   useRawData: true — no bitmap decoding yet.
 * Phase 2 (full parse, ~200-800ms): Decode layer bitmaps with
 *   skipCompositeImageData: true to skip the merged composite.
 *
 * @param file - The .psd file as a File or Blob
 * @param maxPixels - Maximum allowed canvas area (default 3840x2160)
 */
export async function parsePsdFile(
  file: File | Blob,
  maxPixels: number = 3840 * 2160,
): Promise<PsdParseResult> {
  const { readPsd } = await import('ag-psd');
  const arrayBuffer = await file.arrayBuffer();

  // Phase 1: structure-only parse (fast, safe, DoS-hardened)
  const phase1Start = performance.now();
  const psd = readPsd(arrayBuffer, {
    useRawData: true,
    skipThumbnail: true,
    logMissingFeatures: false,
  } as Record<string, unknown>);
  const { width, height } = psd;

  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid PSD dimensions: ${width}x${height}`);
  }
  if (width * height > maxPixels) {
    throw new Error(
      `PSD too large: ${width}x${height} = ${width * height} px ` +
        `(max ${maxPixels}). Rejected to prevent memory exhaustion.`,
    );
  }
  if (width * height * 4 > 256 * 1024 * 1024) {
    throw new Error(
      `PSD memory budget exceeded: ${width}x${height} x 4 bytes = ` +
        `${((width * height * 4) / (1024 * 1024)).toFixed(1)} MB (max 256 MB).`,
    );
  }
  const phase1Time = performance.now() - phase1Start;

  // Phase 2: full parse with layer bitmaps
  const phase2Start = performance.now();
  const fullPsd = readPsd(arrayBuffer, {
    skipCompositeImageData: true,
    skipThumbnail: true,
    logMissingFeatures: false,
  } as Record<string, unknown>);
  const phase2Time = performance.now() - phase2Start;
  const totalTime = performance.now() - phase1Start;

  // Flatten layer tree to DTO list
  const layers: PsdLayerDto[] = [];

  function classifyType(layer: AgPsdLayer): PsdLayerDto['type'] {
    if (layer.children !== undefined) return 'group';
    if (layer.text !== undefined) return 'text';
    if (layer.adjustment !== undefined) return 'adjustment';
    if (layer.placedLayer !== undefined) return 'smart-object';
    if (layer.canvas !== undefined || layer.imageData !== undefined) return 'raster';
    return 'unknown';
  }

  function buildDto(layer: AgPsdLayer, index: number): PsdLayerDto {
    const left = layer.left ?? 0;
    const top = layer.top ?? 0;
    const right = layer.right ?? 0;
    const bottom = layer.bottom ?? 0;
    const type = classifyType(layer);

    const dto: PsdLayerDto = {
      id: String(layer.id ?? `psd-${index}`),
      name: layer.name ?? `Layer ${index + 1}`,
      bounds: {
        x: Math.max(0, left),
        y: Math.max(0, top),
        width: Math.min(width, Math.max(0, right - left)),
        height: Math.min(height, Math.max(0, bottom - top)),
      },
      opacity: layer.opacity ?? 1,
      visible: !layer.hidden,
      type,
    };

    // Build a fully-populated copy including optional fields
    return {
      ...dto,
      ...(type === 'raster' ? { imageBlobId: `psd-layer-${layer.id ?? index}` } : {}),
      ...(type === 'text' && layer.text !== undefined ? { text: layer.text.text } : {}),
    };
  }

  function flatten(layerList: AgPsdLayer[] | undefined, result: PsdLayerDto[]) {
    if (!layerList) return;
    for (let i = 0; i < layerList.length; i++) {
      const layer = layerList[i];
      if (layer === undefined) continue;
      const index = result.length;
      result.push(buildDto(layer, index));
      if (layer.children) flatten(layer.children, result);
    }
  }

  flatten(fullPsd.children, layers);

  console.debug('[psd-parser-spike] parse complete', {
    dimensions: `${width}x${height}`,
    layers: layers.length,
    phase1Ms: phase1Time.toFixed(1),
    phase2Ms: phase2Time.toFixed(1),
    totalMs: totalTime.toFixed(1),
    rasterLayers: layers.filter((l) => l.type === 'raster').length,
    textLayers: layers.filter((l) => l.type === 'text').length,
  });

  return { layers, width, height, parseTimeMs: totalTime };
}
