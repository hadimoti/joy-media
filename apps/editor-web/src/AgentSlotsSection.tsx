import { useEffect, useState } from 'react';
import { confirmDialog } from './app-dialogs.js';
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
import { SETTINGS_AGENT_SLOTS } from './settings-wording.js';

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
      <section className="agent-slots" aria-label={SETTINGS_AGENT_SLOTS.sectionLabel}>
        <p className="agent-slots-note">{SETTINGS_AGENT_SLOTS.desktopNote}</p>
      </section>
    );
  }

  const usableProfiles = profiles.filter((profile) => !RETIRED_PROVIDERS.has(profile.provider));
  const chatGpt = usableProfiles.find((profile) => profile.provider === 'chatgpt');

  // Signs in to ChatGPT for the first time, or signs in again to the connection that is already saved.
  const signInChatGpt = async (id?: string): Promise<void> => {
    setAccountBusy(true);
    setAccountStatus(SETTINGS_AGENT_SLOTS.signInOpening);
    try {
      await signInDesktopProviderProfile({
        provider: 'chatgpt',
        ...(id === undefined ? {} : { id }),
      });
      await onProfilesChanged?.();
      setAccountStatus(
        id === undefined
          ? SETTINGS_AGENT_SLOTS.signInSucceeded
          : SETTINGS_AGENT_SLOTS.signInAgainSucceeded,
      );
    } catch (error) {
      setAccountStatus(
        SETTINGS_AGENT_SLOTS.signInFailed.replace('{reason}', () => errorMessage(error)),
      );
    } finally {
      setAccountBusy(false);
    }
  };

  const logOutChatGpt = async (profile: DesktopProviderProfile): Promise<void> => {
    const confirmed = await confirmDialog({
      message: SETTINGS_AGENT_SLOTS.logOutConfirmation,
      confirmLabel: SETTINGS_AGENT_SLOTS.logOut,
      tone: 'danger',
    });
    if (!confirmed) return;
    setAccountBusy(true);
    setAccountStatus(SETTINGS_AGENT_SLOTS.loggingOut);
    try {
      await signOutDesktopProviderProfile(profile.id);
      await onProfilesChanged?.();
      setAccountStatus(SETTINGS_AGENT_SLOTS.loggedOut);
    } catch (error) {
      setAccountStatus(
        SETTINGS_AGENT_SLOTS.logOutFailed.replace('{reason}', () => errorMessage(error)),
      );
    } finally {
      setAccountBusy(false);
    }
  };

  return (
    <section className="agent-slots" aria-label={SETTINGS_AGENT_SLOTS.sectionLabel}>
      {loadError !== undefined && (
        <p role="alert" className="agent-slots-error">
          {SETTINGS_AGENT_SLOTS.loadFailure.replace('{reason}', () => loadError)}
        </p>
      )}
      <section className="agent-slot-account" aria-label={SETTINGS_AGENT_SLOTS.accountLabel}>
        <h4>{SETTINGS_AGENT_SLOTS.accountLabel}</h4>
        <p className="agent-slots-note">
          {chatGpt === undefined
            ? SETTINGS_AGENT_SLOTS.accountDisconnected
            : SETTINGS_AGENT_SLOTS.accountConnected}
        </p>
        <div className="agent-slot-actions">
          {chatGpt === undefined ? (
            <button
              type="button"
              className="button-primary"
              disabled={accountBusy}
              onClick={() => void signInChatGpt()}
            >
              {SETTINGS_AGENT_SLOTS.connectChatGpt}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="button-secondary"
                disabled={accountBusy}
                onClick={() => void signInChatGpt(chatGpt.id)}
              >
                {SETTINGS_AGENT_SLOTS.logInAgain}
              </button>
              <button
                type="button"
                className="button-secondary"
                disabled={accountBusy}
                onClick={() => void logOutChatGpt(chatGpt)}
              >
                {SETTINGS_AGENT_SLOTS.logOut}
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
          onProfilesChanged={onProfilesChanged}
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
  onProfilesChanged,
}: {
  readonly slot: DesktopAgentSlot;
  readonly profiles: readonly DesktopProviderProfile[];
  readonly onSaved: (next: DesktopAgentSlot) => void;
  readonly onUse: (profile: DesktopProviderProfile) => Promise<void>;
  readonly onProfilesChanged?: (() => unknown) | undefined;
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
    (profileId !== '' && offered.length === 0 ? SETTINGS_AGENT_SLOTS.modelListHint : undefined);

  const refreshModels = async (): Promise<void> => {
    if (profileId === '') return;
    const requested = profileId;
    setListingBusy(true);
    setListingNote(SETTINGS_AGENT_SLOTS.readingModels);
    try {
      const listed = await fetchDesktopProviderModels({ id: requested });
      const ids = listed.map((item) => item.id);
      setListing({ profileId: requested, ids });
      setListingNote(ids.length === 0 ? SETTINGS_AGENT_SLOTS.noModels : undefined);
      // The desktop keeps this list on the saved profile, so the profiles the page shows are read again.
      await onProfilesChanged?.();
    } catch (error) {
      setListingNote(
        SETTINGS_AGENT_SLOTS.readingModelsFailed.replace('{reason}', () => errorMessage(error)),
      );
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
      setStatus(SETTINGS_AGENT_SLOTS.saved.replace('{label}', () => label));
    } catch (error) {
      setStatus(
        SETTINGS_AGENT_SLOTS.saveFailed
          .replace('{label}', () => label)
          .replace('{reason}', () => errorMessage(error)),
      );
    } finally {
      setBusy(false);
    }
  };

  const use = async (): Promise<void> => {
    const profile = profiles.find((item) => item.id === slot.profileId);
    if (profile === undefined || !slot.ready) {
      setStatus(SETTINGS_AGENT_SLOTS.needsProfileAndModel.replace('{label}', () => label));
      return;
    }
    setBusy(true);
    try {
      await onUse(profile);
      setStatus(SETTINGS_AGENT_SLOTS.isCurrentAgentConnection.replace('{label}', () => label));
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className="agent-slot-card"
      aria-label={SETTINGS_AGENT_SLOTS.slotLabel.replace('{label}', () => label)}
    >
      <h4>{label}</h4>
      <label className="agent-slot-field">
        <span>{SETTINGS_AGENT_SLOTS.profileLabel}</span>
        <select
          aria-label={SETTINGS_AGENT_SLOTS.profileAriaLabel.replace('{label}', () => label)}
          value={profileId}
          onChange={(event) => {
            setProfileId(event.target.value);
            setModel('');
            setListingNote(undefined);
            setTypingModel(false);
          }}
        >
          <option value="">{SETTINGS_AGENT_SLOTS.notSet}</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profileLabel(profile)}
            </option>
          ))}
        </select>
      </label>
      <label className="agent-slot-field">
        <span>{SETTINGS_AGENT_SLOTS.modelLabel}</span>
        {showPicker ? (
          <select
            aria-label={SETTINGS_AGENT_SLOTS.modelAriaLabel.replace('{label}', () => label)}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">{SETTINGS_AGENT_SLOTS.chooseModel}</option>
            {model !== '' && !offered.includes(model) && (
              <option value={model}>
                {SETTINGS_AGENT_SLOTS.savedModel.replace('{model}', () => model)}
              </option>
            )}
            {offered.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={SETTINGS_AGENT_SLOTS.modelAriaLabel.replace('{label}', () => label)}
            value={model}
            maxLength={256}
            onChange={(event) => setModel(event.target.value)}
          />
        )}
      </label>
      <div className="agent-slot-actions">
        {offered.length > 0 && (
          <button
            type="button"
            className="button-secondary"
            onClick={() => setTypingModel((current) => !current)}
          >
            {typingModel ? SETTINGS_AGENT_SLOTS.chooseFromList : SETTINGS_AGENT_SLOTS.typeModelId}
          </button>
        )}
        <button
          type="button"
          className="button-secondary"
          disabled={busy || listingBusy || profileId === ''}
          onClick={() => void refreshModels()}
        >
          {SETTINGS_AGENT_SLOTS.refreshModels}
        </button>
      </div>
      {hint !== undefined && <p className="agent-slot-note">{hint}</p>}
      <label className="agent-slot-field">
        <span>{SETTINGS_AGENT_SLOTS.instructionsLabel}</span>
        <textarea
          aria-label={SETTINGS_AGENT_SLOTS.instructionsAriaLabel.replace('{label}', () => label)}
          value={instructions}
          maxLength={4000}
          rows={4}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <div className="agent-slot-settings">
        <label className="agent-slot-field">
          <span>{SETTINGS_AGENT_SLOTS.temperatureLabel}</span>
          <input
            type="number"
            aria-label={SETTINGS_AGENT_SLOTS.temperatureAriaLabel.replace('{label}', () => label)}
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(event) => setTemperature(event.target.value)}
          />
        </label>
        <label className="agent-slot-field">
          <span>{SETTINGS_AGENT_SLOTS.maxOutputTokensLabel}</span>
          <input
            type="number"
            aria-label={SETTINGS_AGENT_SLOTS.maxOutputTokensAriaLabel.replace(
              '{label}',
              () => label,
            )}
            min={1}
            max={32000}
            step={1}
            value={maxOutputTokens}
            onChange={(event) => setMaxOutputTokens(event.target.value)}
          />
        </label>
      </div>
      <div className="agent-slot-actions">
        <button
          type="button"
          className="button-primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {SETTINGS_AGENT_SLOTS.saveSlot.replace('{label}', () => label)}
        </button>
        <button
          type="button"
          className="button-primary"
          disabled={busy || !slot.ready}
          onClick={() => void use()}
        >
          {SETTINGS_AGENT_SLOTS.useForAgent}
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
