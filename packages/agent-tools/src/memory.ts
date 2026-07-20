export interface AgentMemory {
  readonly projectFacts: Readonly<Record<string, unknown>>;
  readonly brandSettings: Readonly<Record<string, unknown>>;
  readonly userPreferences: Readonly<Record<string, unknown>>;
  readonly conversationContext: Readonly<Record<string, unknown>>;
  readonly inferredSuggestions: readonly string[];
}

export interface AgentPreference {
  readonly key: string;
  readonly value: unknown;
  readonly source: 'explicit' | 'inferred' | 'brand';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmed: boolean;
}

export class AgentMemoryManager {
  private projectFacts = new Map<string, unknown>();
  private brandSettings = new Map<string, unknown>();
  private userPreferences = new Map<string, AgentPreference>();
  private conversationContext = new Map<string, unknown>();
  private inferredSuggestions: string[] = [];

  constructor(initialMemory?: Partial<AgentMemory>) {
    if (initialMemory?.projectFacts) {
      for (const [key, value] of Object.entries(initialMemory.projectFacts)) {
        this.projectFacts.set(key, value);
      }
    }
    if (initialMemory?.brandSettings) {
      for (const [key, value] of Object.entries(initialMemory.brandSettings)) {
        this.brandSettings.set(key, value);
      }
    }
    if (initialMemory?.userPreferences) {
      for (const [key, value] of Object.entries(initialMemory.userPreferences)) {
        this.userPreferences.set(key, {
          key,
          value,
          source: 'explicit',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          confirmed: true,
        });
      }
    }
    if (initialMemory?.conversationContext) {
      for (const [key, value] of Object.entries(initialMemory.conversationContext)) {
        this.conversationContext.set(key, value);
      }
    }
    if (initialMemory?.inferredSuggestions) {
      this.inferredSuggestions = [...initialMemory.inferredSuggestions];
    }
  }

  setProjectFact(key: string, value: unknown): void {
    this.projectFacts.set(key, value);
  }

  getProjectFact(key: string): unknown {
    return this.projectFacts.get(key);
  }

  setBrandSetting(key: string, value: unknown): void {
    this.brandSettings.set(key, value);
  }

  getBrandSetting(key: string): unknown {
    return this.brandSettings.get(key);
  }

  setUserPreference(key: string, value: unknown, confirmed: boolean): void {
    const existing = this.userPreferences.get(key);
    const now = new Date().toISOString();

    this.userPreferences.set(key, {
      key,
      value,
      source: existing?.source ?? 'explicit',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      confirmed,
    });
  }

  getUserPreference(key: string): AgentPreference | undefined {
    return this.userPreferences.get(key);
  }

  getAllUserPreferences(): readonly AgentPreference[] {
    return Array.from(this.userPreferences.values());
  }

  setConversationContext(key: string, value: unknown): void {
    this.conversationContext.set(key, value);
  }

  getConversationContext(key: string): unknown {
    return this.conversationContext.get(key);
  }

  clearConversationContext(): void {
    this.conversationContext.clear();
  }

  addInferredSuggestion(suggestion: string): void {
    this.inferredSuggestions.push(suggestion);
  }

  getInferredSuggestions(): readonly string[] {
    return this.inferredSuggestions;
  }

  clearInferredSuggestions(): void {
    this.inferredSuggestions = [];
  }

  confirmSuggestion(key: string, value: unknown): void {
    const now = new Date().toISOString();
    this.userPreferences.set(key, {
      key,
      value,
      source: 'inferred',
      createdAt: now,
      updatedAt: now,
      confirmed: true,
    });
  }

  getMemory(): AgentMemory {
    return {
      projectFacts: Object.fromEntries(this.projectFacts),
      brandSettings: Object.fromEntries(this.brandSettings),
      userPreferences: Object.fromEntries(
        Array.from(this.userPreferences.entries()).map(([k, v]) => [k, v.value]),
      ),
      conversationContext: Object.fromEntries(this.conversationContext),
      inferredSuggestions: [...this.inferredSuggestions],
    };
  }

  exportPreferencesAsJson(): string {
    return JSON.stringify(
      {
        projectFacts: Object.fromEntries(this.projectFacts),
        brandSettings: Object.fromEntries(this.brandSettings),
        userPreferences: Array.from(this.userPreferences.values()),
      },
      null,
      2,
    );
  }
}

export function createAgentMemoryManager(initialMemory?: Partial<AgentMemory>): AgentMemoryManager {
  return new AgentMemoryManager(initialMemory);
}
