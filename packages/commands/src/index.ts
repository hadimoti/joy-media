/**
 * @joy-media/commands — command validation, inversion, transactions, undo/redo.
 *
 * WP-00.2 state: spike command set (insert/remove/move/trim/split/join/property)
 * over the spike project model, with atomic transactions and linear history.
 * Envelope hardening (actor, revisions, idempotency, coalescing) lands in P01.
 */
export const PACKAGE_NAME = '@joy-media/commands' as const;

export type {
  SpikeCommand,
  SpikeCommandType,
  ApplyResult,
  TrackTarget,
  InsertClipPayload,
  RemoveClipPayload,
  MoveClipPayload,
  TrimClipStartPayload,
  TrimClipEndPayload,
  SplitClipPayload,
  JoinClipsPayload,
  SetTrackEnabledPayload,
} from './commands.js';
export { applyCommand, CommandError, COMMAND_REGISTRY } from './commands.js';

export type {
  CommandTransaction,
  HistoryMutation,
  TransactionRecord,
  TransactionResult,
} from './history.js';
export { applyTransaction, ProjectHistory } from './history.js';

export type { AudioState, AudioCommand, AudioApplyResult } from './audio-commands.js';
export { applyAudioCommand, AudioCommandError } from './audio-commands.js';

export type {
  VoiceState,
  VoiceCommand,
  VoiceApplyResult,
} from './voice-commands.js';
export {
  applyVoiceCommand,
  VoiceCommandError,
  createInitialVoiceState,
} from './voice-commands.js';
