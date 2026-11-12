import { BrowserControlPlaneClient } from './control-plane-client.js';
import { StickerImageCache } from './sticker-image-cache.js';
import { createAgentPreviewStore } from './agent-preview-store.js';

/**
 * Editor-wide singletons shared by App.tsx and the monitor. They live in their
 * own module so the monitor can use the same instances without importing App.tsx.
 */

/** One in-memory preview store for this editor instance; never persisted. */
export const appAgentPreviewStore = createAgentPreviewStore();

export const stickerImageCache = new StickerImageCache();

export const mediaControlPlaneClient = new BrowserControlPlaneClient();
