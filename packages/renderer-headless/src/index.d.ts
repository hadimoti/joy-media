/**
 * WP-00.3 deterministic reference path. It has no preview/GPU dependency and
 * consumes the same evaluated Render IR as the Pixi adapter.
 *
 * P16: CPU-side effect pass applied per-node before compositing into the frame.
 */
import type { RenderFrameIR, EffectInstanceIR } from '@joy-media/render-ir';
export declare const PACKAGE_NAME: "@joy-media/renderer-headless";
export interface HeadlessFrame {
    readonly width: number;
    readonly height: number;
    readonly pixels: Uint8Array;
}
export interface EffectDiagnostic {
    readonly instanceId: string;
    readonly effectId: string;
    readonly status: 'applied' | 'bypassed' | 'unsupported' | 'error';
}
export declare function renderHeadlessFrame(frame: RenderFrameIR): HeadlessFrame;
/** Apply CPU-side effects to pixel data. Returns diagnostics for unsupported effects. */
export declare function applyHeadlessEffects(pixels: Uint8Array, width: number, height: number, effects: readonly EffectInstanceIR[] | undefined): EffectDiagnostic[];
//# sourceMappingURL=index.d.ts.map