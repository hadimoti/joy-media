/**
 * Synthesis audit log (WP-05.5, §2.14, §29.9).
 *
 * Records all voice synthesis operations with full provenance. Audit entries
 * are immutable once recorded. Provides queries by voice, user, and time range.
 */

export interface SynthesisAuditEntry {
  readonly id: string;
  readonly voiceIdentityId: string;
  readonly voiceDisplayName: string;
  readonly capability: 'speech.synthesize' | 'voice.clone';
  readonly userId: string;
  readonly timestamp: string;
  readonly purpose: string;
  readonly inputText: string;
  readonly outputAssetId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly consentRecordId: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SynthesisAuditLog {
  record(entry: Omit<SynthesisAuditEntry, 'id' | 'timestamp'>): SynthesisAuditEntry;
  getEntriesForVoice(voiceId: string): readonly SynthesisAuditEntry[];
  getEntriesForUser(userId: string): readonly SynthesisAuditEntry[];
  getEntriesInRange(start: string, end: string): readonly SynthesisAuditEntry[];
  getAllEntries(): readonly SynthesisAuditEntry[];
}

let auditIdCounter = 0;
function generateAuditId(): string {
  auditIdCounter++;
  return `audit-${Date.now()}-${auditIdCounter}`;
}

export function createSynthesisAuditLog(): SynthesisAuditLog {
  const entries: SynthesisAuditEntry[] = [];

  return {
    record(entry: Omit<SynthesisAuditEntry, 'id' | 'timestamp'>): SynthesisAuditEntry {
      const auditEntry: SynthesisAuditEntry = {
        ...entry,
        id: generateAuditId(),
        timestamp: new Date().toISOString(),
      };
      entries.push(auditEntry);
      return auditEntry;
    },

    getEntriesForVoice(voiceId: string): readonly SynthesisAuditEntry[] {
      return entries.filter((e) => e.voiceIdentityId === voiceId);
    },

    getEntriesForUser(userId: string): readonly SynthesisAuditEntry[] {
      return entries.filter((e) => e.userId === userId);
    },

    getEntriesInRange(start: string, end: string): readonly SynthesisAuditEntry[] {
      return entries.filter((e) => e.timestamp >= start && e.timestamp <= end);
    },

    getAllEntries(): readonly SynthesisAuditEntry[] {
      return [...entries];
    },
  };
}
