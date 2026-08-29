/**
 * Keeps the Effects catalog bounded when a category contains more previews
 * than the viewport can display.  A slot is held only while a card is near
 * the viewport, and playback has a smaller independent limit so a scroll
 * cannot create an unbounded number of decoded video pipelines.
 */

export const MAX_MOUNTED_EFFECT_PREVIEWS = 12;
export const MAX_PLAYING_EFFECT_PREVIEWS = 6;

type Grant = () => void;

let nextToken = 1;

interface SlotState {
  readonly active: Map<string, Grant>;
  readonly pending: Map<string, Grant>;
}

function createSlotState(): SlotState {
  return { active: new Map(), pending: new Map() };
}

const mounted = createSlotState();
const playing = createSlotState();

export function createEffectPreviewToken(): string {
  const token = `effect-preview-${nextToken}`;
  nextToken += 1;
  return token;
}

function pump(state: SlotState, limit: number): void {
  while (state.active.size < limit && state.pending.size > 0) {
    const [token, grant] = state.pending.entries().next().value as [string, Grant];
    state.pending.delete(token);
    state.active.set(token, grant);
    grant();
  }
}

function acquire(state: SlotState, limit: number, token: string, grant: Grant): () => void {
  if (state.active.has(token)) return () => release(state, limit, token);
  if (state.active.size < limit) {
    state.active.set(token, grant);
    grant();
  } else {
    state.pending.set(token, grant);
  }
  return () => release(state, limit, token);
}

function release(state: SlotState, limit: number, token: string): void {
  state.pending.delete(token);
  if (state.active.delete(token)) pump(state, limit);
}

export function acquireEffectPreviewMount(token: string, grant: Grant): () => void {
  return acquire(mounted, MAX_MOUNTED_EFFECT_PREVIEWS, token, grant);
}

export function acquireEffectPreviewPlayback(token: string, grant: Grant): () => void {
  return acquire(playing, MAX_PLAYING_EFFECT_PREVIEWS, token, grant);
}
