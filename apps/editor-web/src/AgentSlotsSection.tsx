import { useEffect, useState, type ReactNode } from 'react';
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
import {
  effortFromSettings,
  settingsForEffort,
  type AgentSlotEffort,
} from './agent-slot-effort.js';
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
  /**
   * The connections the page keeps under the two profile cards (the saved list, the sign-in routes, the own-key form).
   * They stand in the same card as the ChatGPT subscription row, so the page reads in the order a person works in.
   */
  readonly children?: ReactNode;
  /** The heading of that card. Without it the card has no heading line. */
  readonly connectionsTitle?: string;
  /** A small control at the right end of the card's heading line. */
  readonly connectionsAction?: ReactNode;
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
  children,
  connectionsTitle,
  connectionsAction,
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
        {renderConnections(connectionsTitle, connectionsAction, undefined, children)}
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

  const accountElement = (
    <section className="agent-slot-account" aria-label={SETTINGS_AGENT_SLOTS.accountLabel}>
      <div className="agent-slot-account-name">
        <h4>{SETTINGS_AGENT_SLOTS.accountLabel}</h4>
        <p className="agent-slots-note">
          {chatGpt === undefined
            ? SETTINGS_AGENT_SLOTS.accountDisconnected
            : SETTINGS_AGENT_SLOTS.accountConnected}
        </p>
      </div>
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
      {accountStatus !== undefined && (
        <p role="status" className="agent-slot-account-status">
          {accountStatus}
        </p>
      )}
    </section>
  );

  return (
    <section className="agent-slots" aria-label={SETTINGS_AGENT_SLOTS.sectionLabel}>
      {loadError !== undefined && (
        <p role="alert" className="agent-slots-error">
          {SETTINGS_AGENT_SLOTS.loadFailure.replace('{reason}', () => loadError)}
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
          onProfilesChanged={onProfilesChanged}
        />
      ))}
      {renderConnections(connectionsTitle, connectionsAction, accountElement, children)}
    </section>
  );
}

/** The connections card: its heading line, the ChatGPT subscription row (desktop only), then the page's connections. */
function renderConnections(
  title: string | undefined,
  action: ReactNode,
  account: ReactNode,
  children: ReactNode,
): ReactNode {
  if (title === undefined && account === undefined && children === undefined) return null;
  return (
    <section className="agent-settings-card joy-connections-card" aria-label={title}>
      {title !== undefined && (
        <header className="joy-card-head">
          <h4>{title}</h4>
          {action}
        </header>
      )}
      {account}
      {children}
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
  const [effort, setEffort] = useState<AgentSlotEffort>(effortFromSettings(slot.settings));
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
    setEffort(effortFromSettings(slot.settings));
  }, [slot]);

  const chosenProfile = profiles.find((item) => item.id === profileId);
  // The models the chosen profile offers: the list read for it, or the list the desktop kept with the profile.
  const offered: readonly string[] =
    listing !== undefined && listing.profileId === profileId
      ? listing.ids
      : (chosenProfile?.cachedModels ?? []);
  const showPicker = offered.length > 0 && !typingModel;
  const hint = listingNote;

  const refreshModels = async (forProfileId: string = profileId): Promise<void> => {
    if (forProfileId === '') return;
    const requested = forProfileId;
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
        settings: settingsForEffort(effort, slot.settings),
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
      className="agent-settings-card agent-slot-card"
      aria-label={SETTINGS_AGENT_SLOTS.slotLabel.replace('{label}', () => label)}
    >
      <header className="joy-card-head">
        <h4 className="agent-slot-title">
          <SlotIcon id={slot.id} />
          {label}
        </h4>
      </header>
      <div className="joy-card-grid">
        <label className="agent-slot-field agent-slot-field-full">
          <span>{SETTINGS_AGENT_SLOTS.profileLabel}</span>
          <select
            aria-label={SETTINGS_AGENT_SLOTS.profileAriaLabel.replace('{label}', () => label)}
            value={profileId}
            onChange={(event) => {
              const chosen = event.target.value;
              setProfileId(chosen);
              setModel('');
              setListingNote(undefined);
              setTypingModel(false);
              // Choosing a provider reads its models at once; they are offered in the model list.
              if (chosen !== '') void refreshModels(chosen);
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
        <div className="agent-slot-field agent-slot-field-full">
          <span>{SETTINGS_AGENT_SLOTS.modelLabel}</span>
          <div className="agent-slot-model-row">
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
                disabled={profileId === ''}
                maxLength={256}
                onChange={(event) => setModel(event.target.value)}
              />
            )}
            {offered.length > 0 && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => setTypingModel((current) => !current)}
              >
                {typingModel
                  ? SETTINGS_AGENT_SLOTS.chooseFromList
                  : SETTINGS_AGENT_SLOTS.typeModelId}
              </button>
            )}
          </div>
          {hint !== undefined && <p className="agent-slot-note">{hint}</p>}
        </div>
        <div className="agent-slot-effort-row agent-slot-field-full">
          <label className="agent-slot-field">
            <span>{SETTINGS_AGENT_SLOTS.effortLabel}</span>
            <select
              aria-label={SETTINGS_AGENT_SLOTS.effortAriaLabel.replace('{label}', () => label)}
              value={effort}
              onChange={(event) => setEffort(event.target.value as AgentSlotEffort)}
            >
              <option value="auto">{SETTINGS_AGENT_SLOTS.effortAuto}</option>
              <option value="low">{SETTINGS_AGENT_SLOTS.effortLow}</option>
              <option value="medium">{SETTINGS_AGENT_SLOTS.effortMedium}</option>
              <option value="high">{SETTINGS_AGENT_SLOTS.effortHigh}</option>
              {effort === 'custom' && (
                <option value="custom">{SETTINGS_AGENT_SLOTS.effortCustom}</option>
              )}
            </select>
          </label>
          <button
            type="button"
            className="button-secondary"
            disabled={busy || listingBusy || profileId === ''}
            onClick={() => void refreshModels()}
          >
            {SETTINGS_AGENT_SLOTS.refreshModels}
          </button>
        </div>
        <label className="agent-slot-field agent-slot-field-full">
          <span>{SETTINGS_AGENT_SLOTS.instructionsLabel}</span>
          <textarea
            aria-label={SETTINGS_AGENT_SLOTS.instructionsAriaLabel.replace('{label}', () => label)}
            value={instructions}
            maxLength={4000}
            rows={4}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
      </div>
      {/* The footer row: the state at the left, the actions at the right, the primary action right-most. */}
      <div className="joy-card-footer joy-card-footer-split">
        {status !== undefined ? (
          <p role="status" className="agent-slot-status">
            {status}
          </p>
        ) : (
          <span />
        )}
        <div className="agent-slot-actions">
          <button
            type="button"
            className="button-secondary"
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
      </div>
    </article>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A small line icon at the left of a slot's name: a wrench for the Workhorse, sparks for the Creative Brain. */
function SlotIcon({ id }: { readonly id: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {id === 'creative' ? (
        <>
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
          <path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />
        </>
      ) : (
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      )}
    </svg>
  );
}
