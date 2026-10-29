import { useEffect, useState } from 'react';
import {
  isDesktopHost,
  listDesktopAgentSlots,
  saveDesktopAgentSlot,
  type DesktopAgentSlot,
  type DesktopAgentSlotDraft,
  type DesktopProviderProfile,
} from './desktop-client.js';

/** Providers that JOY Media no longer runs (PLAN-v4 §9a). A slot cannot name them. */
const RETIRED_PROVIDERS: ReadonlySet<string> = new Set(['kilo', 'joy-hosted']);

export interface AgentSlotsSectionProps {
  /** The saved profiles the dialog already reads. A slot names one of them. */
  readonly profiles: readonly DesktopProviderProfile[];
  /** Runs the agent in this slot: the session takes the slot's profile and model. */
  readonly onUseSlot: (slot: DesktopAgentSlot, profile: DesktopProviderProfile) => Promise<void>;
}

/**
 * The two general-purpose agent slots (D17). Each slot has its own profile, so its own provider and sign-in, and its
 * own model, instructions and settings. Nothing is set until the owner sets it.
 */
export function AgentSlotsSection({ profiles, onUseSlot }: AgentSlotsSectionProps) {
  const [slots, setSlots] = useState<readonly DesktopAgentSlot[]>([]);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    if (!isDesktopHost()) return;
    let cancelled = false;
    listDesktopAgentSlots()
      .then((nextSlots) => {
        if (!cancelled) setSlots(Array.isArray(nextSlots) ? nextSlots : []);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isDesktopHost()) {
    return (
      <section className="agent-slots" aria-label="Agent slots">
        <p className="agent-slots-note">Agent slots are set up in the desktop app.</p>
      </section>
    );
  }

  const usableProfiles = profiles.filter((profile) => !RETIRED_PROVIDERS.has(profile.provider));
  return (
    <section className="agent-slots" aria-label="Agent slots">
      {loadError !== undefined && (
        <p role="alert" className="agent-slots-error">
          Agent slots are unavailable: {loadError}
        </p>
      )}
      {slots.map((slot) => (
        <AgentSlotCard
          key={slot.id}
          slot={slot}
          profiles={usableProfiles}
          onSaved={(next) =>
            setSlots((current) => current.map((item) => (item.id === next.id ? next : item)))
          }
          onUse={(profile) => onUseSlot(slot, profile)}
        />
      ))}
    </section>
  );
}

function AgentSlotCard({
  slot,
  profiles,
  onSaved,
  onUse,
}: {
  readonly slot: DesktopAgentSlot;
  readonly profiles: readonly DesktopProviderProfile[];
  readonly onSaved: (next: DesktopAgentSlot) => void;
  readonly onUse: (profile: DesktopProviderProfile) => Promise<void>;
}) {
  const label = slot.label;
  const [profileId, setProfileId] = useState(slot.profileId ?? '');
  const [model, setModel] = useState(slot.model ?? '');
  const [instructions, setInstructions] = useState(slot.instructions);
  const [temperature, setTemperature] = useState(numberText(slot.settings.temperature));
  const [maxOutputTokens, setMaxOutputTokens] = useState(numberText(slot.settings.maxOutputTokens));
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);

  // A saved slot shows what the desktop stored, so the fields follow it after each save.
  useEffect(() => {
    setProfileId(slot.profileId ?? '');
    setModel(slot.model ?? '');
    setInstructions(slot.instructions);
    setTemperature(numberText(slot.settings.temperature));
    setMaxOutputTokens(numberText(slot.settings.maxOutputTokens));
  }, [slot]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setStatus(undefined);
    try {
      const draft: DesktopAgentSlotDraft = {
        profileId: profileId === '' ? undefined : profileId,
        model: model.trim() === '' ? undefined : model.trim(),
        instructions,
        settings: {
          temperature: parseOptionalNumber(temperature),
          maxOutputTokens: parseOptionalNumber(maxOutputTokens),
        },
      };
      const next = await saveDesktopAgentSlot(slot.id, draft);
      onSaved(next);
      setStatus(`${label} saved.`);
    } catch (error) {
      setStatus(`${label} was not saved: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const use = async (): Promise<void> => {
    const profile = profiles.find((item) => item.id === slot.profileId);
    if (profile === undefined || !slot.ready) {
      setStatus(`Save ${label} with a profile and a model first.`);
      return;
    }
    setBusy(true);
    try {
      await onUse(profile);
      setStatus(`${label} is the connection the agent uses now.`);
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="agent-slot-card" aria-label={`${label} slot`}>
      <h4>{label}</h4>
      <label className="agent-slot-field">
        <span>Provider profile</span>
        <select
          aria-label={`${label} profile`}
          value={profileId}
          onChange={(event) => setProfileId(event.target.value)}
        >
          <option value="">Not set</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name ?? profile.id} ({profile.provider})
            </option>
          ))}
        </select>
      </label>
      <label className="agent-slot-field">
        <span>Model</span>
        <input
          aria-label={`${label} model`}
          value={model}
          maxLength={256}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <label className="agent-slot-field">
        <span>Instructions</span>
        <textarea
          aria-label={`${label} instructions`}
          value={instructions}
          maxLength={4000}
          rows={4}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <div className="agent-slot-settings">
        <label className="agent-slot-field">
          <span>Temperature</span>
          <input
            type="number"
            aria-label={`${label} temperature`}
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(event) => setTemperature(event.target.value)}
          />
        </label>
        <label className="agent-slot-field">
          <span>Max output tokens</span>
          <input
            type="number"
            aria-label={`${label} max output tokens`}
            min={1}
            max={32000}
            step={1}
            value={maxOutputTokens}
            onChange={(event) => setMaxOutputTokens(event.target.value)}
          />
        </label>
      </div>
      <div className="agent-slot-actions">
        <button type="button" disabled={busy} onClick={() => void save()}>
          Save {label}
        </button>
        <button type="button" disabled={busy || !slot.ready} onClick={() => void use()}>
          Use for agent
        </button>
      </div>
      {status !== undefined && <p role="status">{status}</p>}
    </article>
  );
}

function numberText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** Undefined for a blank field. A value that is not a number is kept as NaN, so the desktop refuses it. */
function parseOptionalNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  return Number(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
