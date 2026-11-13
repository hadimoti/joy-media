import type { AgentExecutionMode, ToolCapability } from '@joy-media/agent-tools';

/**
 * The wording of the Joy Code Settings dialog, in plain English.
 *
 * Every word this card rewrites lives here, so the wording can be read in
 * one place, checked against the table, and held by a test that keeps a
 * snapshot of it. The table in `docs/qa/v1.1.1/SETTINGS-WORDING.md` says what
 * each of these words was before.
 *
 * The words are sentence case and free of jargon: no "workspace", no
 * "vault", no "probe", no "BYOK".
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
    description: 'Choose how much Joy Code does on its own, and how much a single run may spend.',
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

/** The dialog itself: its title and the line under it. */
export const SETTINGS_DIALOG = {
  title: 'Joy Code Settings',
  subtitle: 'Settings for Joy Code',
  categoriesLabel: 'Categories',
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
      'Joy Code works through a whole task on its own, as long as it stays inside the limits you set.',
  },
};

/** The cost limit of one run. */
export const SETTINGS_BUDGET = {
  title: 'Cost limit for each run',
  /** `{amount}` is the limit, for example 0.50. */
  tag: 'Up to {amount} per run',
  field: 'Maximum spend per run (USD)',
  hint: 'JOY Media stops a run that would cost more than this. Prices are estimates from the provider. JOY Media itself charges nothing.',
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
  drawingMethod: 'How it draws',
  mediaFolder: 'Your media folder',
  mediaFolderHint: 'See the Asset Library settings',
  backgroundWorker: 'Background worker',
} as const;

/** The models page: the connection, the key and the models. */
export const SETTINGS_MODELS = {
  browseButton: 'Browse models and connections',
  presetTitle: 'Your own API key',
  presetHint: 'One provider, with a key you enter here',
  noModel: 'No model connected',
  readyToEdit: 'Ready to edit your project',
  briefOnly: 'Ready for a creative brief only',
  connectBelow: 'Connect a model below to start.',
  savedConnections: 'Saved connections',
  legacyProfile: 'Old connection, no longer used',
  signInAgain: 'Sign in again',
  signOutAndRevoke: 'Sign out and remove access',
  connectionTitle: 'Connection and sign-in',
  yourOwnEndpoint: 'Your own endpoint',
  providerLabel: 'Provider',
  openRouterOption: 'OpenRouter (your own key)',
  otherProviderOption: 'Another provider (OpenAI compatible)',
  connectionNameLabel: 'Name this connection (optional)',
  serviceAddressLabel: 'Service address (base URL)',
  keyLabel: 'Your API key',
  modelIdLabel: 'Model ID (you can change this)',
  showModelList: 'Show model list',
  hideModelList: 'Hide model list',
  findModelsTooltip: 'Find the models this service offers',
  findingModels: 'Finding models…',
  findModels: 'Find models',
  modelsTitle: 'Models found on this service',
  modelsReady: '{count} models ready',
  openToFind: 'Open to find models',
  modelsHint: 'Choose a model to fill in the model ID, or type a word to filter the list.',
  checkingAgain: 'Checking again…',
  lookAgain: 'Look again',
  lookingForModels: 'Looking for models…',
  noModelsYet:
    'No models yet. Enter the service address and your key above, then choose Find models.',
  noModelMatches: 'No model matches that filter.',
} as const;

/** Fills `{amount}` in the cost limit tag. */
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
