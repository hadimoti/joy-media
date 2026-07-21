import type { VoiceIdentity, VoiceStatus, ConsentRecord } from '@joy-media/project-schema';

export interface VoiceState {
  readonly voices: Readonly<Record<string, VoiceIdentity>>;
  readonly consentRecords: Readonly<Record<string, ConsentRecord>>;
}

let voiceIdCounter = 0;
let consentIdCounter = 0;
function generateVoiceId(): string {
  voiceIdCounter++;
  return `voice-${Date.now()}-${voiceIdCounter}`;
}
function generateConsentId(): string {
  consentIdCounter++;
  return `consent-${Date.now()}-${consentIdCounter}`;
}

export type VoiceCommand =
  | {
      readonly type: 'voiceIdentity.create';
      readonly payload: {
        readonly id?: string;
        readonly displayName: string;
        readonly ownerUserId?: string;
        readonly allowedPurposes: readonly string[];
        readonly allowedUsersOrTeams: readonly string[];
        readonly expiresAt?: string;
        readonly consentGrantedBy: string;
        readonly metadata?: Record<string, unknown>;
      };
    }
  | {
      readonly type: 'voiceIdentity.update';
      readonly payload: {
        readonly voiceId: string;
        readonly displayName?: string;
        readonly allowedPurposes?: readonly string[];
        readonly allowedUsersOrTeams?: readonly string[];
        readonly expiresAt?: string;
        readonly metadata?: Record<string, unknown>;
      };
    }
  | {
      readonly type: 'voiceIdentity.suspend';
      readonly payload: { readonly voiceId: string; readonly reason: string };
    }
  | {
      readonly type: 'voiceIdentity.revoke';
      readonly payload: { readonly voiceId: string; readonly reason: string };
    }
  | {
      readonly type: 'voiceIdentity.delete';
      readonly payload: { readonly voiceId: string };
    }
  | {
      readonly type: 'voiceIdentity.restore';
      readonly payload: { readonly voiceId: string };
    }
  | {
      readonly type: 'consent.grant';
      readonly payload: {
        readonly voiceId: string;
        readonly grantedBy: string;
        readonly purposes: readonly string[];
        readonly expiresAt?: string;
        readonly restrictions?: string;
      };
    }
  | {
      readonly type: 'consent.revoke';
      readonly payload: { readonly consentId: string; readonly reason: string };
    };

export class VoiceCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VoiceCommandError';
    this.code = code;
  }
}

export interface VoiceApplyResult {
  readonly state: VoiceState;
  readonly inverse: VoiceCommand;
}

export function applyVoiceCommand(state: VoiceState, command: VoiceCommand): VoiceApplyResult {
  switch (command.type) {
    case 'voiceIdentity.create':
      return applyVoiceCreate(state, command.payload);
    case 'voiceIdentity.update':
      return applyVoiceUpdate(state, command.payload);
    case 'voiceIdentity.suspend':
      return applyVoiceSuspend(state, command.payload);
    case 'voiceIdentity.revoke':
      return applyVoiceRevoke(state, command.payload);
    case 'voiceIdentity.delete':
      return applyVoiceDelete(state, command.payload);
    case 'voiceIdentity.restore':
      return applyVoiceRestore(state, command.payload);
    case 'consent.grant':
      return applyConsentGrant(state, command.payload);
    case 'consent.revoke':
      return applyConsentRevoke(state, command.payload);
    default: {
      const exhaustive: never = command;
      throw new VoiceCommandError(
        'VOICE_COMMAND_UNKNOWN_TYPE',
        `unknown voice command ${String(exhaustive)}`,
      );
    }
  }
}

function applyVoiceCreate(
  state: VoiceState,
  payload: Extract<VoiceCommand, { type: 'voiceIdentity.create' }>['payload'],
): VoiceApplyResult {
  const now = new Date().toISOString();
  const voiceId = payload.id ?? generateVoiceId();
  const consentId = generateConsentId();

  if (state.voices[voiceId] !== undefined) {
    throw new VoiceCommandError(
      'VOICE_COMMAND_DUPLICATE_ID',
      `voice id "${voiceId}" already exists`,
    );
  }

  const consentRecord: ConsentRecord = {
    id: consentId,
    voiceIdentityId: voiceId,
    grantedBy: payload.consentGrantedBy,
    grantedAt: now,
    purposes: [...payload.allowedPurposes],
    revoked: false,
    ...(payload.expiresAt !== undefined && { expiresAt: payload.expiresAt }),
  };

  const voice: VoiceIdentity = {
    id: voiceId,
    displayName: payload.displayName,
    consentRecordId: consentId,
    allowedPurposes: [...payload.allowedPurposes],
    allowedUsersOrTeams: [...payload.allowedUsersOrTeams],
    providerVoiceRefs: [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...(payload.ownerUserId !== undefined && { ownerUserId: payload.ownerUserId }),
    ...(payload.expiresAt !== undefined && { expiresAt: payload.expiresAt }),
    ...(payload.metadata !== undefined && { metadata: payload.metadata }),
  };

  const newState: VoiceState = {
    voices: { ...state.voices, [voiceId]: voice },
    consentRecords: { ...state.consentRecords, [consentId]: consentRecord },
  };

  return {
    state: newState,
    inverse: {
      type: 'voiceIdentity.delete',
      payload: { voiceId },
    },
  };
}

function applyVoiceUpdate(
  state: VoiceState,
  payload: Extract<VoiceCommand, { type: 'voiceIdentity.update' }>['payload'],
): VoiceApplyResult {
  const voice = state.voices[payload.voiceId];
  if (!voice) {
    throw new VoiceCommandError(
      'VOICE_COMMAND_UNKNOWN_TARGET',
      `unknown voice "${payload.voiceId}"`,
    );
  }
  if (voice.status === 'deleted') {
    throw new VoiceCommandError(
      'VOICE_COMMAND_INVALID_STATUS',
      `cannot update deleted voice "${payload.voiceId}"`,
    );
  }

  const previousPayload: Record<string, unknown> = {};
  const updated: VoiceIdentity = {
    ...voice,
    ...(payload.displayName !== undefined ? { displayName: payload.displayName } : {}),
    ...(payload.allowedPurposes !== undefined
      ? { allowedPurposes: [...payload.allowedPurposes] }
      : {}),
    ...(payload.allowedUsersOrTeams !== undefined
      ? { allowedUsersOrTeams: [...payload.allowedUsersOrTeams] }
      : {}),
    ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
    ...(payload.metadata !== undefined
      ? { metadata: { ...voice.metadata, ...payload.metadata } }
      : {}),
    updatedAt: new Date().toISOString(),
  };

  if (payload.displayName !== undefined) previousPayload.displayName = voice.displayName;
  if (payload.allowedPurposes !== undefined)
    previousPayload.allowedPurposes = voice.allowedPurposes;
  if (payload.allowedUsersOrTeams !== undefined)
    previousPayload.allowedUsersOrTeams = voice.allowedUsersOrTeams;
  if (payload.expiresAt !== undefined) previousPayload.expiresAt = voice.expiresAt;
  if (payload.metadata !== undefined) previousPayload.metadata = voice.metadata;

  const newState: VoiceState = {
    ...state,
    voices: { ...state.voices, [payload.voiceId]: updated },
  };

  return {
    state: newState,
    inverse: {
      type: 'voiceIdentity.update',
      payload: { voiceId: payload.voiceId, ...previousPayload },
    },
  };
}

function applyVoiceSuspend(
  state: VoiceState,
  payload: { readonly voiceId: string; readonly reason: string },
): VoiceApplyResult {
  const voice = state.voices[payload.voiceId];
  if (!voice) {
    throw new VoiceCommandError(
      'VOICE_COMMAND_UNKNOWN_TARGET',
      `unknown voice "${payload.voiceId}"`,
    );
  }
  if (voice.status === 'deleted') {
    throw new VoiceCommandError(
      'VOICE_COMMAND_INVALID_STATUS',
      `cannot suspend deleted voice "${payload.voiceId}"`,
    );
  }

  const previousStatus: VoiceStatus = voice.status;
  const updated: VoiceIdentity = {
    ...voice,
    status: 'suspended',
    updatedAt: new Date().toISOString(),
    metadata: { ...voice.metadata, suspensionReason: payload.reason },
  };

  const newState: VoiceState = {
    ...state,
    voices: { ...state.voices, [payload.voiceId]: updated },
  };

  if (previousStatus === 'suspended') {
    return {
      state: newState,
      inverse: {
        type: 'voiceIdentity.suspend',
        payload: { voiceId: payload.voiceId, reason: payload.reason },
      },
    };
  }

  return {
    state: newState,
    inverse: {
      type: 'voiceIdentity.restore',
      payload: { voiceId: payload.voiceId },
    },
  };
}

function applyVoiceRevoke(
  state: VoiceState,
  payload: { readonly voiceId: string; readonly reason: string },
): VoiceApplyResult {
  const voice = state.voices[payload.voiceId];
  if (!voice) {
    throw new VoiceCommandError(
      'VOICE_COMMAND_UNKNOWN_TARGET',
      `unknown voice "${payload.voiceId}"`,
    );
  }
  if (voice.status === 'deleted') {
    throw new VoiceCommandError(
      'VOICE_COMMAND_INVALID_STATUS',
      `cannot revoke deleted voice "${payload.voiceId}"`,
    );
  }

  const now = new Date().toISOString();
  const updated: VoiceIdentity = {
    ...voice,
    status: 'revoked',
    updatedAt: now,
    metadata: { ...voice.metadata, revocationReason: payload.reason },
  };

  const consent = state.consentRecords[voice.consentRecordId];
  let newConsentRecords = state.consentRecords;
  if (consent && !consent.revoked) {
    const updatedConsent: ConsentRecord = {
      ...consent,
      revoked: true,
      revokedAt: now,
      revocationReason: payload.reason,
    };
    newConsentRecords = { ...state.consentRecords, [voice.consentRecordId]: updatedConsent };
  }

  const newState: VoiceState = {
    voices: { ...state.voices, [payload.voiceId]: updated },
    consentRecords: newConsentRecords,
  };

  return {
    state: newState,
    inverse: {
      type: 'voiceIdentity.restore',
      payload: { voiceId: payload.voiceId },
    },
  };
}

function applyVoiceDelete(
  state: VoiceState,
  payload: { readonly voiceId: string },
): VoiceApplyResult {
  const voice = state.voices[payload.voiceId];
  if (!voice) {
    throw new VoiceCommandError(
      'VOICE_COMMAND_UNKNOWN_TARGET',
      `unknown voice "${payload.voiceId}"`,
    );
  }

  const updated: VoiceIdentity = {
    ...voice,
    status: 'deleted',
    updatedAt: new Date().toISOString(),
  };

  const newState: VoiceState = {
    ...state,
    voices: { ...state.voices, [payload.voiceId]: updated },
  };

  return {
    state: newState,
    inverse: {
      type: 'voiceIdentity.restore',
      payload: { voiceId: payload.voiceId },
    },
  };
}

function applyVoiceRestore(
  state: VoiceState,
  payload: { readonly voiceId: string },
): VoiceApplyResult {
  const voice = state.voices[payload.voiceId];
  if (!voice) {
    throw new VoiceCommandError(
      'VOICE_COMMAND_UNKNOWN_TARGET',
      `unknown voice "${payload.voiceId}"`,
    );
  }
  if (voice.status !== 'revoked' && voice.status !== 'suspended' && voice.status !== 'deleted') {
    throw new VoiceCommandError(
      'VOICE_COMMAND_INVALID_STATUS',
      `cannot restore voice "${payload.voiceId}" with status "${voice.status}"`,
    );
  }

  const previousStatus: VoiceStatus = voice.status;
  const updated: VoiceIdentity = {
    ...voice,
    status: 'active',
    updatedAt: new Date().toISOString(),
  };

  const newState: VoiceState = {
    ...state,
    voices: { ...state.voices, [payload.voiceId]: updated },
  };

  if (previousStatus === 'suspended') {
    return {
      state: newState,
      inverse: {
        type: 'voiceIdentity.suspend',
        payload: { voiceId: payload.voiceId, reason: 'inverse of restore' },
      },
    };
  }

  return {
    state: newState,
    inverse: {
      type: 'voiceIdentity.revoke',
      payload: { voiceId: payload.voiceId, reason: 'inverse of restore' },
    },
  };
}

function applyConsentGrant(
  state: VoiceState,
  payload: Extract<VoiceCommand, { type: 'consent.grant' }>['payload'],
): VoiceApplyResult {
  const voice = state.voices[payload.voiceId];
  if (!voice) {
    throw new VoiceCommandError(
      'VOICE_COMMAND_UNKNOWN_TARGET',
      `unknown voice "${payload.voiceId}"`,
    );
  }

  const now = new Date().toISOString();
  const consentId = generateConsentId();

  const consentRecord: ConsentRecord = {
    id: consentId,
    voiceIdentityId: payload.voiceId,
    grantedBy: payload.grantedBy,
    grantedAt: now,
    purposes: [...payload.purposes],
    revoked: false,
    ...(payload.expiresAt !== undefined && { expiresAt: payload.expiresAt }),
    ...(payload.restrictions !== undefined && { restrictions: payload.restrictions }),
  };

  const newState: VoiceState = {
    ...state,
    consentRecords: { ...state.consentRecords, [consentId]: consentRecord },
  };

  return {
    state: newState,
    inverse: {
      type: 'consent.revoke',
      payload: { consentId, reason: 'inverse of grant' },
    },
  };
}

function applyConsentRevoke(
  state: VoiceState,
  payload: { readonly consentId: string; readonly reason: string },
): VoiceApplyResult {
  const consent = state.consentRecords[payload.consentId];
  if (!consent) {
    throw new VoiceCommandError(
      'VOICE_COMMAND_UNKNOWN_TARGET',
      `unknown consent record "${payload.consentId}"`,
    );
  }
  if (consent.revoked) {
    throw new VoiceCommandError(
      'VOICE_COMMAND_ALREADY_REVOKED',
      `consent record "${payload.consentId}" is already revoked`,
    );
  }

  const now = new Date().toISOString();
  const updated: ConsentRecord = {
    ...consent,
    revoked: true,
    revokedAt: now,
    revocationReason: payload.reason,
  };

  const newState: VoiceState = {
    ...state,
    consentRecords: { ...state.consentRecords, [payload.consentId]: updated },
  };

  return {
    state: newState,
    inverse: {
      type: 'consent.grant',
      payload: {
        voiceId: consent.voiceIdentityId,
        grantedBy: consent.grantedBy,
        purposes: consent.purposes,
        ...(consent.expiresAt !== undefined && { expiresAt: consent.expiresAt }),
        ...(consent.restrictions !== undefined && { restrictions: consent.restrictions }),
      },
    },
  };
}

export function createInitialVoiceState(): VoiceState {
  return {
    voices: {},
    consentRecords: {},
  };
}
