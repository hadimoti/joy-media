import type { AgentExecutionMode, ToolCapability } from '@joy-media/agent-tools';

/**
 * The wording of the Joy Code Settings dialog, in plain English.
 *
 * Every word the dialog shows lives here: the pages, the modes, the labels,
 * the notices and the refusals. The dialog reads them from this one file, so
 * the wording can be read in one place, checked against the table in
 * `docs/qa/v1.1.1/SETTINGS-WORDING.md`, and held by a test that keeps a
 * snapshot of it.
 *
 * The words are sentence case and free of jargon: no "workspace", no
 * "vault", no "probe", no "BYOK".
 *
 * Two rules the words must keep:
 *
 * 1. They say what the code does. The cost number is the point at which
 *    JOY Media asks, not a cap on the run, so the words say exactly that.
 * 2. Nothing here is a secret, a key or a token.
 */

/** The five pages of the dialog, in the order the list on the left shows them. */
export const SETTINGS_PAGE_IDS = [
  'models',
  'execution',
  'experience',
  'permissions',
  'diagnostics',
] as const;

/** The page a settings dialog is showing. */
export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number];

/** What one page of the dialog says about itself. */
export interface SettingsPageWording {
  /** The name in the list on the left. */
  readonly name: string;
  /** The small line above the heading. */
  readonly kicker: string;
  /** The heading on the right. */
  readonly title: string;
  /** The line under the heading. */
  readonly description: string;
}

/** The five pages, in plain words. */
export const SETTINGS_PAGES: Readonly<Record<SettingsPageId, SettingsPageWording>> = {
  models: {
    name: 'AI models',
    kicker: 'Models and connections',
    title: 'AI models',
    description: 'Choose the model Joy Code uses, and the service and key it connects with.',
  },
  execution: {
    name: 'Safety and limits',
    kicker: 'How much Joy Code does on its own',
    title: 'Safety and limits',
    description:
      'Choose how much Joy Code does on its own, and when it should ask you before it spends.',
  },
  experience: {
    name: 'Live preview',
    kicker: 'What you see while it works',
    title: 'Live preview',
    description: 'Choose whether you see a live preview on the canvas while Joy Code works.',
  },
  permissions: {
    name: 'Tools and permissions',
    kicker: 'What Joy Code may change',
    title: 'Tools and permissions',
    description: 'Choose what Joy Code is allowed to read and change.',
  },
  diagnostics: {
    name: 'Media support check',
    kicker: 'How your computer handles it',
    title: 'Media support check',
    description:
      'Check that your computer draws the picture, and that the model understands pictures, sound and video.',
  },
};

/** The dialog itself: its title, the line under it, and its frame. */
export const SETTINGS_DIALOG = {
  title: 'Joy Code Settings',
  subtitle: 'Settings for Joy Code',
  categoriesLabel: 'Categories',
  categoriesNavLabel: 'Settings categories',
  closeLabel: 'Close settings',
  doneLabel: 'Done',
} as const;

/** What one way of working says. */
export interface SettingsModeWording {
  /** The name on the card. */
  readonly name: string;
  /** One sentence saying what this mode does. */
  readonly sentence: string;
}

/**
 * The four ways Joy Code can work. The default one says so, and only that
 * one does.
 */
export const SETTINGS_MODES: Readonly<Record<AgentExecutionMode, SettingsModeWording>> = {
  'suggest-only': {
    name: 'Suggest only',
    sentence:
      'Joy Code writes out what it would change and waits for you, and it never touches your project by itself.',
  },
  'preview-and-approve': {
    name: 'Preview and approve (default)',
    sentence: 'Joy Code shows the change in the editor first, and only makes it when you say yes.',
  },
  'auto-apply-low-risk': {
    name: 'Apply safe changes',
    sentence:
      'Joy Code applies small, reversible changes such as cuts and trims on its own, and asks before anything bigger.',
  },
  'full-auto-limited': {
    name: 'Work on its own',
    sentence:
      'Joy Code works through a whole task on its own, and asks you first when one step may cost more than your limit.',
  },
};

/**
 * The cost number.
 *
 * The code does not stop a run when it goes over this number. The number is
 * the auto-approval threshold of "Work on its own": the approval engine
 * looks at the estimate of each step, and a step that may cost more than
 * this is sent to you for approval. The words say exactly that, and nothing
 * more.
 */
export const SETTINGS_BUDGET = {
  title: 'When to ask you about cost',
  /** `{amount}` is the estimated cost threshold for one step. */
  tag: 'Ask above {amount} for one step',
  field: 'Ask me before a step that may cost more than this (USD)',
  hint: 'In "Work on its own", JOY Media asks for your approval when one step of a run may cost more than this. It is not a limit on what a whole run may spend. Prices are estimates from the provider. JOY Media itself charges nothing.',
} as const;

/** Where the settings and the keys are kept. */
export const SETTINGS_STORAGE = {
  savedNote: 'Saved on this computer',
  keyNote: 'Your keys are stored encrypted on this PC.',
  footer: 'Saved on this computer. Your keys are stored encrypted on this PC.',
} as const;

/** The check that tells whether the model understands media. */
export const SETTINGS_MEDIA_CHECK = {
  modelsTitle: 'Media support check',
  modelsHint:
    'Sends three tiny test clips to the model to see whether it understands pictures, sound and video. Your project and your media are never sent. Your provider may still charge for these three small requests.',
  checkedTag: 'Checked',
  notCheckedTag: 'Not checked yet',
  diagnosticsTitle: 'Does the model understand media?',
  diagnosticsHint: 'Checks whether the model you chose understands pictures, sound and video.',
  notCheckedYet: 'Not checked yet for this model.',
  configuredModel: 'Configured model:',
  imageLabel: 'Image',
  audioLabel: 'Audio',
  videoLabel: 'Video',
  supported: 'Supported',
  unavailable: 'Unavailable',
  check: 'Check media support',
  checking: 'Checking media support…',
  checkingShort: 'Checking…',
  invalidResult:
    'Media capability check returned an invalid result. Reconnect the model and try again.',
  couldNotComplete:
    'Media capability check could not be completed. Reconnect the model and try again.',
  /** `{model}` is the model that was checked. */
  completeFor: 'Media capability check complete for {model}.',
} as const;

/** What Joy Code may change. */
export const SETTINGS_TOOLS = {
  title: 'What Joy Code may change',
  /** `{allowed}` and `{total}` are the two numbers of the count. */
  allowedTag: '{allowed} of {total} allowed',
  /** The name of each permission, in plain words. */
  names: {
    'timeline.read': 'Read the timeline',
    'timeline.write': 'Change the timeline',
    'assets.read': 'Read your media',
    'assets.import': 'Bring in new media',
    'filesystem.read': 'Read files',
    'filesystem.write': 'Write files',
    'provider.generate': 'Ask the model to create media',
    'provider.spend': 'Spend money at the provider',
    'render.preview': 'Draw previews',
    'export.write': 'Write the exported file',
    'project.overwrite': 'Overwrite the project',
    'plugin.invoke': 'Run plugins',
  } satisfies Readonly<Record<ToolCapability, string>>,
} as const;

/** The live preview page. */
export const SETTINGS_LIVE_PREVIEW = {
  title: 'What you see while Joy Code works',
  switchLabel: 'Show what Joy Code is doing on the canvas while it works',
} as const;

/** The page that says how the computer is doing. */
export const SETTINGS_DIAGNOSTICS = {
  hardwareTitle: 'How your computer draws the picture',
  accelerationTag: 'Hardware acceleration is on',
  graphicsCard: 'Graphics card',
  graphicsCardName: 'NVIDIA GeForce RTX 5070 Ti',
  drawingMethod: 'How it draws',
  drawingMethodName: 'ANGLE D3D11',
  mediaFolder: 'Your media folder',
  mediaFolderHint: 'See the Asset Library settings',
  backgroundWorker: 'Background service',
  backgroundWorkerName: 'JOY Media background service',
} as const;

/** The models page: the connection, the key, the models and the check. */
export const SETTINGS_MODELS = {
  browseButton: 'Browse models and connections',
  presetTitle: 'Your own API key',
  presetHint: 'One provider, with a key you enter here',
  noModel: 'No model connected',
  activeModel: 'Active: {model}',
  readyToEdit: 'Ready to edit your project',
  briefOnly: 'Ready for a creative brief only',
  connectBelow: 'Connect a model below to start.',
  connectionFailed: 'Connection failed. See the details below.',
  savedConnections: 'Saved connections',
  legacyProfile: 'Old connection, no longer used',
  keyUnreadable: 'Saved key could not be read. Enter it again.',
  keyConfirmAgain: 'Enter the key again to confirm this endpoint.',
  disconnect: 'Disconnect',
  useButton: 'Use',
  laterButton: 'Later',
  working: 'Working…',
  signInAgain: 'Sign in again',
  signOutAndRevoke: 'Sign out and remove access',
  removeChatGptLabel: 'Remove ChatGPT profile locally',
  /** `{profile}` is the name of the saved connection. */
  removeProfileLabel: 'Remove {profile} profile',
  connectionTitle: 'Connection and sign-in',
  providerTagNone: 'No provider',
  providerTagOpenRouter: 'OpenRouter',
  yourOwnEndpoint: 'Your own endpoint',
  providerLabel: 'Provider',
  chooseProvider: 'Choose a provider',
  openRouterOption: 'OpenRouter (your own key)',
  otherProviderOption: 'Another provider (OpenAI compatible)',
  regionLabel: 'Region',
  getKeyAt: 'Get a key at',
  connectionNameLabel: 'Name this connection (optional)',
  connectionNamePlaceholder: 'e.g. My OpenRouter, Local Ollama',
  serviceAddressLabel: 'Service address (base URL)',
  serviceAddressPlaceholder: 'https://...',
  keyLabel: 'Your API key',
  savedKeyPlaceholder: '•••••••••••••••• (Leave blank to keep saved)',
  keyPlaceholder: 'sk-...',
  customEndpointConsent:
    'I understand that custom endpoints may log requests according to their own policy.',
  modelIdLabel: 'Model ID (you can change this)',
  modelIdName: 'Model ID',
  modelIdPlaceholder: 'provider/model',
  showModelList: 'Show model list',
  hideModelList: 'Hide model list',
  findModelsTooltip: 'Find the models this service offers',
  findingModels: 'Finding models…',
  findModels: 'Find models',
  lookAgain: 'Look again',
  lookAgainName: 'Look again for models',
  lookAgainTitle: 'Ask this service for its models again',
  connect: 'Connect model',
  connecting: 'Connecting…',
  clearConnection: 'Clear connection',
  modelsTitle: 'Models found on this service',
  modelsReady: '{count} models ready',
  openToFind: 'Open to find models',
  modelsHint: 'Choose a model to fill in the model ID, or type a word to filter the list.',
  checkingAgain: 'Checking again…',
  lookingForModels: 'Looking for models…',
  noModelsYet:
    'No models yet. Enter the service address and your key above, then choose Find models.',
  noModelMatches: 'No model matches that filter.',
  filterPlaceholder: 'Filter models (e.g. free, sonnet, 4o)...',
  filterAll: 'All',
  filterFree: 'Free',
  filterClaude: 'Claude',
  filterGpt: 'GPT',
  browserOnly: 'Live model discovery requires Joy Media Desktop.',
} as const;

/** The desktop-only agent slots shown at the top of the models page. */
export const SETTINGS_AGENT_SLOTS = {
  sectionLabel: 'Agent slots',
  desktopNote: 'Agent slots are set up in the desktop app.',
  loadFailure: 'Agent slots are unavailable: {reason}',
  accountLabel: 'ChatGPT subscription',
  accountDisconnected: 'ChatGPT is not connected.',
  accountConnected: 'ChatGPT is connected.',
  connectChatGpt: 'Connect ChatGPT',
  logInAgain: 'Log in again',
  logOut: 'Log out',
  slotLabel: '{label} slot',
  profileLabel: 'Provider profile',
  profileAriaLabel: '{label} profile',
  notSet: 'Not set',
  modelLabel: 'Model',
  modelAriaLabel: '{label} model',
  chooseModel: 'Choose a model',
  savedModel: '{model} (saved)',
  chooseFromList: 'Choose from the list',
  typeModelId: 'Type a model ID',
  refreshModels: 'Refresh models',
  instructionsLabel: 'Instructions',
  instructionsAriaLabel: '{label} instructions',
  temperatureLabel: 'Temperature',
  temperatureAriaLabel: '{label} temperature',
  maxOutputTokensLabel: 'Max output tokens',
  maxOutputTokensAriaLabel: '{label} max output tokens',
  saveSlot: 'Save {label}',
  useForAgent: 'Use for agent',
  signInOpening: 'Opening ChatGPT in your browser to sign in…',
  signInSucceeded: 'ChatGPT is connected.',
  signInAgainSucceeded: 'ChatGPT signed in again.',
  signInFailed: 'ChatGPT sign-in did not complete: {reason}',
  logOutConfirmation:
    'Log out of ChatGPT? JOY Media revokes this connection, and the Workhorse slot stays empty until you connect again.',
  loggingOut: 'Logging out of ChatGPT…',
  loggedOut: 'Logged out of ChatGPT. The connection was removed.',
  logOutFailed: 'ChatGPT did not confirm the log out, so the connection was kept: {reason}',
  modelListHint: 'Refresh models to choose from the list this account offers, or type a model ID.',
  readingModels: 'Reading the models this profile offers…',
  noModels: 'This profile offers no models. Type a model ID.',
  readingModelsFailed: 'The models could not be read: {reason}',
  saved: '{label} saved.',
  saveFailed: '{label} was not saved: {reason}',
  needsProfileAndModel: 'Save {label} with a profile and a model first.',
  isCurrentAgentConnection: '{label} is the connection the agent uses now.',
} as const;

/** Sign-in routes and API-key fields inside the provider panel. */
export const SETTINGS_PROVIDER_SIGN_IN = {
  oauthRiskNotice:
    'Signing in uses a third-party public app, and the provider may disable it in the future. An API key is the better, more dependable way to connect.',
  signedIn: 'Signed in to {provider}.',
  waitingForBrowser: 'Waiting for the browser. {time} left.',
  openSignInPageAgain: 'Open the sign-in page again',
  cancelSignIn: 'Cancel',
  signInCancelled: 'Sign-in cancelled. You can start again.',
  signInFailed: 'The {provider} sign-in did not complete.',
  modelIdRequired: 'Enter a model ID before saving.',
  apiKeyRequired: 'Enter an API key before saving.',
  apiKeySaved: 'API key saved on this computer.',
  apiKeySaveFailed: 'API key could not be saved. Check the fields and try again.',
  toggleRoutesLabel: 'Toggle {provider} connection routes',
  bothRoutesTag: 'Sign-in + API key',
  signInOnlyTag: 'Sign-in only',
  oauthRouteLabel: '{provider} OAuth route',
  oauthRouteTitle: 'Sign-in route (Primary)',
  signInButton: 'Sign in with {provider}',
  signInButtonBusy: 'Sign in with {provider}…',
  apiKeyRouteLabel: '{provider} API-key route',
  apiKeyRouteTitle: 'API key route (Secondary)',
  noApiKeyEndpoint:
    'No API-key endpoint is registered for this provider. OpenAI API keys remain under the separate OpenAI provider.',
  apiKeyRegionLabel: '{provider} API key region',
  baseUrlLabel: 'OpenAI-compatible base URL',
  baseUrlAriaLabel: '{provider} API key base URL',
  apiKeyLabel: 'API key',
  createApiKey: 'Create API key',
  apiSecretKeyLabel: 'API Secret Key',
  apiKeyAriaLabel: '{provider} API key',
  modelIdLabel: 'Model ID',
  modelIdAriaLabel: '{provider} Model ID',
  saveApiKey: 'Save API key',
} as const;

/**
 * Everything the dialog says when it answers, refuses or reports.
 *
 * These are the notices and the refusals. They are plain sentences, and they
 * are kept here with the rest of the wording.
 */
export const SETTINGS_MESSAGES = {
  profilesDidNotLoad: 'The saved profiles did not load in time.',
  profilesUnreadable:
    'The saved profiles could not be read. Close and reopen settings to try again.',
  profilesLoading: 'The saved profiles are still loading.',
  slotNotReady: 'This agent slot cannot run yet. Save it with a profile and a model.',
  chooseProviderBeforeDiscovery: 'Choose a provider before discovering models.',
  chooseProviderBeforeConnect: 'Choose a provider before connecting.',
  ambiguousEndpoint:
    'More than one saved profile uses this endpoint. Choose one in the list first.',
  consentBeforeDiscovery: 'Enter the custom-provider acknowledgement before discovering models.',
  consentBeforeConnect: 'Enter the custom-provider acknowledgement before connecting.',
  acknowledgeEndpoint: 'Acknowledge this custom endpoint before connecting.',
  keyForOtherEndpoint: 'The key was entered for a different provider or endpoint. Enter it again.',
  keyAgain: 'Enter the API key again to confirm this endpoint.',
  keyAgainThenConnect: 'Enter the API key again to confirm this endpoint, then connect.',
  baseUrlBeforeDiscovery: 'Please enter a Base URL before discovering models',
  discoveryFailed: 'Failed to discover models behind endpoint',
  connectionFailed: 'The connection failed.',
  configureFailed: 'Unable to configure connection',
  providerNoToolLoop: 'The provider responded, but JOY could not use its tool loop.',
  connectedReady: 'Connected successfully. JOY is ready to edit in this session.',
  connectedBriefOnly:
    'Connected successfully in plan-only mode. Creative Brief is ready in this session.',
  /** `{reason}` is why the connection failed. */
  connectionFailedWith: 'Connection failed: {reason}',
  savedKeyOtherEndpoint:
    'The saved API key belongs to a different provider or endpoint. Enter a new API key to connect.',
  apiKeyRequired: 'API key is required.',
  modelIdRequired: 'Model ID is required.',
  baseUrlRequired: 'Base URL is required.',
  profileNotReadBack: 'The saved profile could not be read back. Try connecting again.',
  connectionNotSaved: 'This connection could not be saved in the desktop app.',
  removeChatGptConfirm:
    'Remove this ChatGPT connection from JOY Media without revoking its authorization? This does not revoke access in ChatGPT.',
  removeLabel: 'Remove',
  removeFailed: 'Could not remove the saved profile.',
  reauthorized: 'ChatGPT connection reauthorized.',
  reauthorizeFailed: 'ChatGPT reauthorization did not complete.',
  signOutConfirm:
    'Sign out of this ChatGPT connection and revoke its saved authorization? JOY Media will remove the saved profile after ChatGPT confirms revocation.',
  signOutLabel: 'Sign out',
  revoked: 'ChatGPT authorization revoked and the saved connection was removed.',
  signOutFailed: 'ChatGPT could not confirm sign-out.',
  removeLocallyLabel: 'Remove locally',
  removeLocallyConfirm:
    'Remove this connection from JOY Media locally without revoking it? This does not revoke access in ChatGPT.',
  removedLocally: 'ChatGPT connection removed locally. This did not revoke access in ChatGPT.',
  removeLocallyFailed: 'Could not remove the saved profile locally.',
  connectionCleared: 'Connection cleared. Your API key was removed from this page session.',
  /** `{items}` is the list of what is still missing. */
  missingItems: 'Enter {items} before connecting.',
  missingKeyAgain: 'the API key again to confirm this endpoint',
  missingNewKey: 'a new API key because the saved key belongs to a different provider or endpoint',
  missingAnyKey: 'an API key',
  missingModelId: 'a model ID',
  missingBaseUrl: 'a base URL',
  missingConsent: 'the custom-provider acknowledgement',
} as const;

/** Fills `{amount}` in the cost tag. */
export function budgetTag(amount: string): string {
  return SETTINGS_BUDGET.tag.replace('{amount}', `$${amount}`);
}

/** Fills `{allowed}` and `{total}` in the count of the tools list. */
export function allowedToolsTag(allowed: number, total: number): string {
  return SETTINGS_TOOLS.allowedTag
    .replace('{allowed}', String(allowed))
    .replace('{total}', String(total));
}

/** Fills `{count}` in the number of models that were found. */
export function modelsReadyTag(count: number): string {
  return SETTINGS_MODELS.modelsReady.replace('{count}', String(count));
}

/** Fills `{model}` in the message of a finished media check. */
export function mediaCheckComplete(model: string): string {
  return SETTINGS_MEDIA_CHECK.completeFor.replace('{model}', model);
}

/** Fills `{reason}` in the message of a failed connection. */
export function connectionFailedMessage(reason: string): string {
  return SETTINGS_MESSAGES.connectionFailedWith.replace('{reason}', reason);
}

/** Fills `{profile}` in the name of the button that removes a saved connection. */
export function removeProfileLabel(profile: string): string {
  return SETTINGS_MODELS.removeProfileLabel.replace('{profile}', profile);
}

/** Fills `{items}` in the message that says what is still missing. */
export function missingItemsMessage(items: string): string {
  return SETTINGS_MESSAGES.missingItems.replace('{items}', items);
}
