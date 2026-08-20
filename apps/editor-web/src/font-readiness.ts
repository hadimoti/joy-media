export interface FontReadinessPlatform {
  readonly check: (family: string) => boolean;
  readonly ready: Promise<unknown>;
}

export class FontReadinessError extends Error {
  readonly code = 'CONTENT_FONT_NOT_READY';
  readonly families: readonly string[];
  constructor(families: readonly string[]) {
    super(`Required content fonts are not ready: ${families.join(', ')}`);
    this.name = 'FontReadinessError';
    this.families = families;
  }
}

export async function waitForContentFonts(
  families: readonly string[],
  options: { readonly timeoutMs?: number; readonly platform?: FontReadinessPlatform } = {},
): Promise<void> {
  const unique = [...new Set(families.filter((family) => family.trim().length > 0))];
  if (unique.length === 0) return;
  const platform = options.platform ?? resolvePlatform();
  const timeoutMs = options.timeoutMs ?? 3_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      platform.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FontReadinessError(unique)), timeoutMs);
      }),
    ]);
  } catch {
    throw new FontReadinessError(unique);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const missing = unique.filter((family) => !platform.check(family));
  if (missing.length > 0) throw new FontReadinessError(missing);
}

function resolvePlatform(): FontReadinessPlatform {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  return fonts === undefined
    ? { check: () => true, ready: Promise.resolve() }
    : { check: (family) => fonts.check(`16px "${family}"`), ready: fonts.ready };
}
