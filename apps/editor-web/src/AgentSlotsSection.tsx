import { useEffect, useState } from 'react';
import {
  fetchDesktopProviderModels,
  isDesktopHost,
  listDesktopAgentSlots,
  saveDesktopAgentSlot,
  signInDesktopProviderProfile,
  signOutDesktopProviderProfile,
  type DesktopAgentSlot,
  type DesktopAgentSlotDraft,
  type DesktopProviderProfile,
} from './desktop-client.js';
import { profileLabel } from './provider-labels.js';

/** Providers that JOY Media no longer runs (PLAN-v4 §9a). A slot cannot name them. */
const RETIRED_PROVIDERS: ReadonlySet<string> = new Set(['kilo', 'joy-hosted']);

export interface AgentSlotsSectionProps {
  /** The saved profiles the dialog already reads. A slot names one of them. */
  readonly profiles: readonly DesktopProviderProfile[];
  /** Runs the agent in this slot: the session takes the slot's profile and model. */
  readonly onUseSlot: (slot: DesktopAgentSlot, profile: DesktopProviderProfile) => Promise<void>;
  /** Reads the saved profiles again after a ChatGPT sign-in, sign-in again or log out. */
  readonly onProfilesChanged?: () => unknown;
}

/**
 * The two general-purpose agent slots (D17). Each slot has its own profile, so its own provider and sign-in, and its
 * own model, instructions and settings. Nothing is set until the owner sets it. The one exception is a first ChatGPT
 * sign-in, which fills an empty Workhorse: the desktop does that when it saves the sign-in.
 */
export function AgentSlotsSection({
  profiles,
  onUseSlot,
  onProfilesChanged,
}: AgentSlotsSectionProps) {
  const [slots, setSlots] = useState<readonly DesktopAgentSlot[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [accountStatus, setAccountStatus] = useState<string>();
  const [accountBusy, setAccountBusy] = useState(false);

  // The slots are read again whenever the saved profiles change: a sign-in can fill Workhorse, and a log out empties it.
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
  }, [profiles]);

  if (!isDesktopHost()) {
    return (
      <section className="agent-slots" aria-label="Agent slots">
        <p className="agent-slots-note">Agent slots are set up in the desktop app.</p>
      </section>
    );
  }

  const usableProfiles = profiles.filter((profile) => !RETIRED_PROVIDERS.has(profile.provider));
  const chatGpt = usableProfiles.find((profile) => profile.provider === 'chatgpt');

  // Signs in to ChatGPT for the first time, or signs in again to the connection that is already saved.
  const signInChatGpt = async (id?: string): Promise<void> => {
    setAccountBusy(true);
    setAccountStatus('Opening ChatGPT in your browser to sign in…');
    try {
      await signInDesktopProviderProfile({
        provider: 'chatgpt',
        ...(id === undefined ? {} : { id }),
      });
      await onProfilesChanged?.();
      setAccountStatus(id === undefined ? 'ChatGPT is connected.' : 'ChatGPT signed in again.');
    } catch (error) {
      setAccountStatus(`ChatGPT sign-in did not complete: ${errorMessage(error)}`);
    } finally {
      setAccountBusy(false);
    }
  };

  const logOutChatGpt = async (profile: DesktopProviderProfile): Promise<void> => {
    if (
      !window.confirm(
        'Log out of ChatGPT? JOY Media revokes this connection, and the Workhorse slot stays empty until you connect again.',
      )
    ) {
      return;
    }
    setAccountBusy(true);
    setAccountStatus('Logging out of ChatGPT…');
    try {
      await signOutDesktopProviderProfile(profile.id);
      await onProfilesChanged?.();
      setAccountStatus('Logged out of ChatGPT. The connection was removed.');
    } catch (error) {
      setAccountStatus(
        `ChatGPT did not confirm the log out, so the connection was kept: ${errorMessage(error)}`,
      );
    } finally {
      setAccountBusy(false);
    }
  };

  return (
    <section className="agent-slots" aria-label="Agent slots">
      {loadError !== undefined && (
        <p role="alert" className="agent-slots-error">
          Agent slots are unavailable: {loadError}
        </p>
      )}
      <section className="agent-slot-account" aria-label="ChatGPT subscription">
        <h4>ChatGPT subscription</h4>
        <p className="agent-slots-note">
          {chatGpt === undefined ? 'ChatGPT is not connected.' : 'ChatGPT is connected.'}
        </p>
        <div className="agent-slot-actions">
          {chatGpt === undefined ? (
            <button type="button" disabled={accountBusy} onClick={() => void signInChatGpt()}>
              Connect ChatGPT
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={accountBusy}
                onClick={() => void signInChatGpt(chatGpt.id)}
              >
                Log in again
              </button>
              <button
                type="button"
                disabled={accountBusy}
                onClick={() => void logOutChatGpt(chatGpt)}
              >
                Log out
              </button>
            </>
          )}
        </div>
        {accountStatus !== undefined && <p role="status">{accountStatus}</p>}
      </section>
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
  // The models read for one profile. A list read for another profile is never offered here.
  const [listing, setListing] = useState<{
    readonly profileId: string;
    readonly ids: readonly string[];
  }>();
  const [listingNote, setListingNote] = useState<string>();
  const [listingBusy, setListingBusy] = useState(false);
  const [typingModel, setTypingModel] = useState(false);

  // A saved slot shows what the desktop stored, so the fields follow it after each save.
  useEffect(() => {
    setProfileId(slot.profileId ?? '');
    setModel(slot.model ?? '');
    setInstructions(slot.instructions);
    setTemperature(numberText(slot.settings.temperature));
    setMaxOutputTokens(numberText(slot.settings.maxOutputTokens));
  }, [slot]);

  const chosenProfile = profiles.find((item) => item.id === profileId);
  // The models the chosen profile offers: the list read for it, or the list the desktop kept with the profile.
  const offered: readonly string[] =
    listing !== undefined && listing.profileId === profileId
      ? listing.ids
      : (chosenProfile?.cachedModels ?? []);
  const showPicker = offered.length > 0 && !typingModel;
  const hint =
    listingNote ??
    (profileId !== '' && offered.length === 0
      ? 'Refresh models to choose from the list this account offers, or type a model ID.'
      : undefined);

  const refreshModels = async (): Promise<void> => {
    if (profileId === '') return;
    const requested = profileId;
    setListingBusy(true);
    setListingNote('Reading the models this profile offers…');
    try {
      const listed = await fetchDesktopProviderModels({ id: requested });
      const ids = listed.map((item) => item.id);
      setListing({ profileId: requested, ids });
      setListingNote(
        ids.length === 0 ? 'This profile offers no models. Type a model ID.' : undefined,
      );
    } catch (error) {
      setListingNote(`The models could not be read: ${errorMessage(error)}`);
    } finally {
      setListingBusy(false);
    }
  };

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
          onChange={(event) => {
            setProfileId(event.target.value);
            setModel('');
            setListingNote(undefined);
            setTypingModel(false);
          }}
        >
          <option value="">Not set</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profileLabel(profile)}
            </option>
          ))}
        </select>
      </label>
      <label className="agent-slot-field">
        <span>Model</span>
        {showPicker ? (
          <select
            aria-label={`${label} model`}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">Choose a model</option>
            {model !== '' && !offered.includes(model) && (
              <option value={model}>{model} (saved)</option>
            )}
            {offered.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={`${label} model`}
            value={model}
            maxLength={256}
            onChange={(event) => setModel(event.target.value)}
          />
        )}
      </label>
      <div className="agent-slot-actions">
        {offered.length > 0 && (
          <button type="button" onClick={() => setTypingModel((current) => !current)}>
            {typingModel ? 'Choose from the list' : 'Type a model ID'}
          </button>
        )}
        <button
          type="button"
          disabled={busy || listingBusy || profileId === ''}
          onClick={() => void refreshModels()}
        >
          Refresh models
        </button>
      </div>
      {hint !== undefined && <p className="agent-slot-note">{hint}</p>}
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
