export type FixedPreviewQuality = 'quarter' | 'half' | 'full';
export type PreviewQuality = 'auto' | FixedPreviewQuality;
export interface PreviewFrameRate {
  readonly num: number;
  readonly den: number;
}

export interface AutoPreviewQualityState {
  readonly consecutiveFastFrames: number;
  readonly holdFramesRemaining: number;
}

export interface AutoPreviewQualityDecision {
  readonly quality: FixedPreviewQuality;
  readonly state: AutoPreviewQualityState;
}

export const INITIAL_AUTO_PREVIEW_QUALITY_STATE: AutoPreviewQualityState = {
  consecutiveFastFrames: 0,
  holdFramesRemaining: 0,
};

const FAST_FRAMES_TO_STEP_UP = 30;
const HOLD_TIME_AFTER_STEP_DOWN_MS = 1_000;
const STEP_UP_BUDGET_RATIO = 0.7;

export const DEFAULT_PREVIEW_QUALITY: PreviewQuality = 'auto';

export function previewQualityScale(quality: FixedPreviewQuality): number {
  switch (quality) {
    case 'quarter':
      return 0.25;
    case 'half':
      return 0.5;
    case 'full':
      return 1;
  }
}

/** Internal GPU pixel density. The authored viewport/CSS size is unchanged. */
export function previewQualityResolution(quality: FixedPreviewQuality): number {
  return previewQualityScale(quality);
}

export function previewQualityLabel(quality: PreviewQuality): string {
  switch (quality) {
    case 'auto':
      return 'Auto';
    case 'quarter':
      return 'Quarter';
    case 'half':
      return 'Half';
    case 'full':
      return 'Full';
  }
}

export function previewDimensions(
  width: number,
  height: number,
  quality: FixedPreviewQuality,
): { readonly width: number; readonly height: number } {
  const scale = previewQualityScale(quality);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Step down against the frame budget immediately. Step up by one level only
 * after a sustained fast run, with history supplied by the caller so the
 * decision stays deterministic and clock-free.
 */
export function chooseAutoPreviewQuality(
  measuredQuality: FixedPreviewQuality,
  renderDurationMs: number,
  frameRate: PreviewFrameRate,
  state: AutoPreviewQualityState,
): AutoPreviewQualityDecision {
  const fps = frameRate.num / frameRate.den;
  if (
    !(fps > 0) ||
    !Number.isFinite(fps) ||
    !(renderDurationMs >= 0) ||
    !Number.isFinite(renderDurationMs)
  ) {
    return {
      quality: measuredQuality,
      state: { ...state, consecutiveFastFrames: 0 },
    };
  }

  const frameBudgetMs = 1000 / fps;
  if (renderDurationMs > frameBudgetMs) {
    const lowerQualities = lowerPreviewQualities(measuredQuality);
    const nextQuality =
      lowerQualities.find(
        (candidate) =>
          estimateDuration(renderDurationMs, measuredQuality, candidate) <= frameBudgetMs,
      ) ?? lowerQualities.at(-1);
    if (nextQuality !== undefined) {
      return {
        quality: nextQuality,
        state: {
          consecutiveFastFrames: 0,
          holdFramesRemaining: Math.ceil((fps * HOLD_TIME_AFTER_STEP_DOWN_MS) / 1_000),
        },
      };
    }
  }

  if (state.holdFramesRemaining > 0) {
    return {
      quality: measuredQuality,
      state: {
        consecutiveFastFrames: 0,
        holdFramesRemaining: state.holdFramesRemaining - 1,
      },
    };
  }

  const nextQuality = higherPreviewQuality(measuredQuality);
  if (nextQuality === undefined) {
    return {
      quality: measuredQuality,
      state: { consecutiveFastFrames: 0, holdFramesRemaining: 0 },
    };
  }

  const estimatedNextDuration = estimateDuration(renderDurationMs, measuredQuality, nextQuality);
  if (estimatedNextDuration >= frameBudgetMs * STEP_UP_BUDGET_RATIO) {
    return {
      quality: measuredQuality,
      state: { consecutiveFastFrames: 0, holdFramesRemaining: 0 },
    };
  }

  const consecutiveFastFrames = state.consecutiveFastFrames + 1;
  if (consecutiveFastFrames >= FAST_FRAMES_TO_STEP_UP) {
    return {
      quality: nextQuality,
      state: { consecutiveFastFrames: 0, holdFramesRemaining: 0 },
    };
  }

  return {
    quality: measuredQuality,
    state: { consecutiveFastFrames, holdFramesRemaining: 0 },
  };
}

function lowerPreviewQualities(quality: FixedPreviewQuality): readonly FixedPreviewQuality[] {
  switch (quality) {
    case 'full':
      return ['half', 'quarter'];
    case 'half':
      return ['quarter'];
    case 'quarter':
      return [];
  }
}

function higherPreviewQuality(quality: FixedPreviewQuality): FixedPreviewQuality | undefined {
  switch (quality) {
    case 'quarter':
      return 'half';
    case 'half':
      return 'full';
    case 'full':
      return undefined;
  }
}

function estimateDuration(
  renderDurationMs: number,
  measuredQuality: FixedPreviewQuality,
  estimatedQuality: FixedPreviewQuality,
): number {
  const measuredAreaScale = previewQualityScale(measuredQuality) ** 2;
  const estimatedAreaScale = previewQualityScale(estimatedQuality) ** 2;
  return renderDurationMs * (estimatedAreaScale / measuredAreaScale);
}

/** Resolve a saved mode to the fixed quality the renderer should draw now. */
export function resolvePreviewQuality(
  quality: PreviewQuality,
  autoQuality: FixedPreviewQuality,
  paused: boolean,
): FixedPreviewQuality {
  if (quality !== 'auto') return quality;
  return paused ? 'full' : autoQuality;
}
