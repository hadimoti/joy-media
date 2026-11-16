/**
 * A fake Playwright page for the T-A11 cases: a small model of the Joy Code settings dialog and
 * the Joy Code thread, built from the labels in `provider-settings-steps.mjs`. It lets the cases
 * run with no app (`provider-settings-run.mjs --dry-run`, and the unit tests).
 *
 * It models what the wording promises, not what the real app does: the live pass is the check.
 * `options` switch faults on so a test can show that a case notices them:
 *   previewWrites       the preview writes a clip before approval
 *   suggestOnlyApplies  Suggest only applies the edit
 *   autoModesApply      the two automatic modes apply without asking
 *   noProposalMode      that execution mode replies without staging an edit
 *   orphanApprovalMode  that execution mode exposes approval without its proposal card
 *   keepConsentOnEdit   editing the public URL keeps the consent ticked
 *   leakKeyInReply      an IPC reply echoes the typed key
 */

const LABELS = ['Workhorse', 'Creative Brain'];

function nameOf(options) {
  const { name } = options ?? {};
  if (name instanceof RegExp) return `/${name.source}/`;
  return name ?? '';
}

function textOf(value) {
  return value instanceof RegExp ? `/${value.source}/` : String(value);
}

export function createFakeApp(options = {}) {
  const state = {
    panelOpen: false,
    settingsOpen: false,
    settingsPage: 'AI models',
    endpointOpen: false,
    provider: '',
    url: '',
    key: '',
    modelId: '',
    consentUrl: undefined,
    consentTicked: false,
    notice: undefined,
    drawerNotice: undefined,
    drawerOpen: false,
    connected: false,
    profiles: 0,
    modelsFound: false,
    mediaChecked: false,
    slotProfile: [false, false],
    slotModel: ['', ''],
    slotSaved: [false, false],
    slotInUse: [false, false],
    mode: 'preview-and-approve',
    draft: '',
    clips: 1,
    stage: 'none',
    orphanApproval: false,
    messages: 0,
    hello: false,
    slow: false,
    cancelled: false,
    safeStop: false,
    ipc: [],
  };
  const calls = [];

  const slotIndex = (desc) => Number(/nth=(\d)/u.exec(desc)?.[1] ?? 0);
  const last = (desc) => desc.split(' > ').at(-1);

  function applyEdit() {
    state.clips += 1;
    state.stage = 'applied';
  }

  function submit() {
    const text = state.draft;
    state.draft = '';
    state.messages += 1;
    if (text.startsWith('STUB-HELLO')) {
      state.hello = true;
      state.messages += 1;
    } else if (text.startsWith('STUB-SLOW')) {
      state.slow = true;
      state.cancelled = false;
    } else if (text.startsWith('STUB-PLAN')) {
      state.stage = 'none';
      state.orphanApproval = false;
      state.safeStop = options.safeStopMode === state.mode;
      if (options.orphanApprovalMode === state.mode) {
        state.orphanApproval = true;
        state.messages += 1;
      } else if (options.noProposalMode === state.mode) {
        state.messages += 1;
      } else if (state.mode === 'suggest-only') {
        if (options.suggestOnlyApplies) applyEdit();
        else state.messages += 1;
      } else if (state.mode === 'preview-and-approve') {
        if (options.previewWrites) state.clips += 1;
        state.stage = 'proposal';
      } else if (options.autoModesApply) {
        applyEdit();
      } else {
        state.stage = 'proposal';
      }
    }
  }

  function visible(desc) {
    const tail = last(desc);
    const inDialog = desc.includes('role=dialog[Joy Code Settings]');
    if (tail === 'role=dialog[Joy Code Settings]') return state.settingsOpen;
    if (tail.includes('Joy Code could not finish this run safely')) return state.safeStop;
    if (inDialog && !state.settingsOpen) return false;
    if (tail.startsWith('role=textbox[Message Joy Code]')) return state.panelOpen;
    if (tail.includes('Enter the custom-provider acknowledgement before connecting'))
      return state.notice === 'connect-refusal';
    if (tail.includes('acknowledgement before discovering models'))
      return state.drawerNotice === 'discover-refusal';
    if (tail.includes('Choose a provider before discovering models'))
      return state.drawerNotice === 'choose-provider';
    if (tail.includes('No models yet')) return state.drawerOpen && !state.modelsFound;
    if (tail.includes('I understand that custom endpoints')) return state.provider !== '';
    if (tail.includes('Ready to edit your project')) return state.connected;
    if (tail.includes('Saved connections \\(1\\)')) return state.profiles === 1;
    if (tail.includes('Saved connections')) return state.profiles > 0;
    if (tail.includes('1 models ready')) return state.modelsFound;
    if (tail.includes('joy-settings-model-chip')) return state.drawerOpen && state.modelsFound;
    if (tail.includes('Media capability check complete')) return state.mediaChecked;
    if (tail.includes('Hello from the JOY QA stub.')) return state.hello;
    if (tail.includes('Reverted.')) return state.stage === 'reverted';
    if (tail.includes('JOY run cancelled')) return state.cancelled;
    if (tail.includes('Last Joy Code run'))
      return state.stage === 'applied' || state.stage === 'reverted';
    for (const label of LABELS) {
      const index = LABELS.indexOf(label);
      if (tail.includes(`${label} saved.`)) return state.slotSaved[index];
      if (tail.includes(`${label} is the connection the agent uses now.`))
        return state.slotInUse[index];
      if (tail.includes(`[aria-label="${label} model"]`)) return state.slotProfile[index];
    }
    return true;
  }

  function count(desc) {
    const tail = last(desc);
    if (tail.includes('.timeline-clip')) return state.clips;
    if (tail.includes('JOY Agent live proposal')) return state.stage === 'proposal' ? 1 : 0;
    if (tail.includes('Proposed timeline plan')) return 0;
    if (tail.includes('Approve & apply'))
      return state.stage === 'proposal' || state.orphanApproval ? 1 : 0;
    if (tail.includes('Apply edit')) return 0;
    if (tail.includes('Undo run')) return state.stage === 'applied' ? 1 : 0;
    if (tail.includes('Last Joy Code run'))
      return state.stage === 'applied' || state.stage === 'reverted' ? 1 : 0;
    if (tail.includes('Reverted.')) return state.stage === 'reverted' ? 1 : 0;
    if (tail.includes('is thinking')) return 0;
    if (tail.includes('Reading the models')) return 0;
    if (tail.includes('Reject')) return 0;
    if (tail.includes('.joy-code-message')) return state.messages;
    if (tail.includes('role=button[Stop current plan]'))
      return state.slow && !state.cancelled ? 1 : 0;
    if (tail.includes('role=button[Stop]')) return state.slow && !state.cancelled ? 1 : 0;
    if (tail.includes('agent-slot-card')) return 2;
    return visible(desc) ? 1 : 0;
  }

  function click(desc) {
    const tail = last(desc);
    if (tail === 'role=button[Joy Code]') return;
    if (tail.includes('Open Joy Code')) state.panelOpen = true;
    else if (tail.startsWith('role=button[Joy Code Settings]')) state.settingsOpen = true;
    else if (tail.startsWith('role=button[Close settings]')) state.settingsOpen = false;
    else if (
      desc.includes('role=dialog[Joy Code Settings]') &&
      /role=button\[(AI models|Safety and limits)\]/u.test(tail)
    ) {
      state.settingsPage = /\[(AI models|Safety and limits)\]/u.exec(tail)[1];
    } else if (tail.includes('Connection and sign-in')) {
      state.endpointOpen = !state.endpointOpen;
    } else if (tail.includes('/Models found on this service/')) {
      state.drawerOpen = !state.drawerOpen;
    } else if (tail.startsWith('role=button[Connect model]')) {
      if (state.consentUrl !== state.url) state.notice = 'connect-refusal';
      else if (state.url.startsWith('http://127.0.0.1')) {
        state.notice = undefined;
        state.connected = true;
        state.profiles = 1;
        state.ipc.push(
          JSON.stringify({ channel: 'desktop.provider-profile.save', reply: { id: 'p1' } }),
        );
        if (options.leakKeyInReply) {
          state.ipc.push(JSON.stringify({ channel: 'x', reply: { echo: state.key } }));
        }
      }
    } else if (tail.startsWith('role=button[Show model list]')) {
      if (state.provider === '') state.drawerNotice = 'choose-provider';
      else if (state.consentUrl !== state.url) state.drawerNotice = 'discover-refusal';
    } else if (tail.startsWith('role=button[Find models]')) {
      if (state.connected) state.modelsFound = true;
    } else if (tail.startsWith('role=button[Check media support]')) {
      state.mediaChecked = true;
    } else if (/^role=button\[Save /u.test(tail)) {
      const label = /^role=button\[Save (.+)\]$/u.exec(tail)[1];
      state.slotSaved[LABELS.indexOf(label)] = true;
    } else if (tail.startsWith('role=button[Use for agent]')) {
      const index = slotIndex(desc);
      state.slotInUse[index] = true;
    } else if (tail.includes('joy-settings-mode-card')) {
      const name = /has text\[(.+?)\]/u.exec(desc)?.[1];
      const modes = {
        'Suggest only': 'suggest-only',
        'Preview and approve (default)': 'preview-and-approve',
        'Apply safe changes': 'auto-apply-low-risk',
        'Work on its own': 'full-auto-limited',
      };
      if (name && modes[name]) state.mode = modes[name];
    } else if (tail.includes('Approve & apply')) {
      applyEdit();
    } else if (tail.includes('Undo run')) {
      state.stage = 'reverted';
      state.clips -= 1;
    } else if (tail.startsWith('role=button[Stop current plan]') || tail === 'role=button[Stop]') {
      state.cancelled = true;
      state.slow = false;
    } else if (/role=button\[\/\^Remove/u.test(tail)) {
      state.profiles = 0;
      state.connected = false;
    }
  }

  function fill(desc, value) {
    const tail = last(desc);
    if (tail.startsWith('role=textbox[Message Joy Code]')) state.draft = value;
    else if (tail.startsWith('ph[https://...]')) {
      if (value !== state.url && !options.keepConsentOnEdit) state.consentTicked = false;
      if (value !== state.url) state.notice = undefined;
      state.url = value;
    } else if (tail.includes('type="password"')) state.key = value;
    else if (tail.startsWith('role=textbox[Model ID]')) state.modelId = value;
    else if (tail.includes('aria-label="') && tail.includes(' model"]')) {
      state.slotModel[slotIndex(desc)] = value;
    }
  }

  return { state, calls, visible, count, click, fill, submit, slotIndex, last };
}

class FakeLocator {
  constructor(app, desc) {
    this.app = app;
    this.desc = desc;
  }

  next(part) {
    return new FakeLocator(this.app, `${this.desc} > ${part}`);
  }

  getByRole(role, options) {
    return this.next(`role=${role}[${nameOf(options)}]`);
  }

  getByText(value) {
    return this.next(`text[${textOf(value)}]`);
  }

  getByPlaceholder(value) {
    return this.next(`ph[${value}]`);
  }

  locator(selector, options) {
    const hasText = options?.hasText ? ` has text[${textOf(options.hasText)}]` : '';
    return this.next(`css[${selector}]${hasText}`);
  }

  filter(options) {
    const inner = options?.has?.desc ?? '';
    const text = /text\[(.+)\]$/u.exec(inner)?.[1] ?? '';
    return new FakeLocator(this.app, `${this.desc} has text[${text}]`);
  }

  first() {
    return this;
  }

  nth(index) {
    return this.next(`nth=${index}`);
  }

  async click() {
    this.app.calls.push(['click', this.desc]);
    this.app.click(this.desc);
  }

  async fill(value) {
    this.app.calls.push(['fill', this.desc]);
    this.app.fill(this.desc, value);
  }

  async press(key) {
    this.app.calls.push(['press', this.desc, key]);
    if (key === 'Enter') this.app.submit();
  }

  async check() {
    this.app.calls.push(['check', this.desc]);
    this.app.state.consentUrl = this.app.state.url;
    this.app.state.consentTicked = true;
  }

  async isChecked() {
    return this.app.state.consentTicked;
  }

  async selectOption(value) {
    this.app.calls.push(['selectOption', this.desc]);
    const { state } = this.app;
    if (this.desc.endsWith('css[.joy-own-key select]')) state.provider = String(value);
    else if (this.desc.includes('agent-slot-card') && !this.desc.includes('aria-label')) {
      state.slotProfile[this.app.slotIndex(this.desc)] = true;
    } else if (this.desc.includes('aria-label')) {
      state.slotModel[this.app.slotIndex(this.desc)] = String(value);
    }
  }

  async isVisible() {
    return this.app.visible(this.desc);
  }

  async isDisabled() {
    const tail = this.app.last(this.desc);
    if (tail.includes('Check media support')) return !this.app.state.connected;
    if (tail.includes('Refresh models')) {
      const index = this.app.slotIndex(this.desc);
      return !this.app.state.slotProfile[index];
    }
    if (tail.includes('[aria-label="') && tail.includes(' model"]')) {
      return !this.app.state.slotProfile[this.app.slotIndex(this.desc)];
    }
    return false;
  }

  async count() {
    return this.app.count(this.desc);
  }

  async waitFor({ state = 'visible' } = {}) {
    const shown = this.app.visible(this.desc);
    if (state === 'visible' && !shown) throw new Error(`not visible: ${this.desc}`);
    if (state === 'hidden' && shown) throw new Error(`still visible: ${this.desc}`);
  }

  async innerText() {
    const tail = this.app.last(this.desc);
    if (tail.includes('agent-slot-title')) return LABELS[this.app.slotIndex(this.desc)] ?? 'Slot';
    if (tail.includes('joy-settings-probe-grid'))
      return 'Image\nSupported\nAudio\nUnavailable\nVideo\nSupported';
    return '';
  }

  async getAttribute(name) {
    if (name === 'aria-expanded' && this.desc.includes('Models found on this service')) {
      return String(this.app.state.drawerOpen);
    }
    if (name === 'aria-expanded' && this.desc.includes('Connection and sign-in')) {
      return String(this.app.state.endpointOpen);
    }
    if (name === 'class') {
      const mode = /has text\[(.+?)\]/u.exec(this.desc)?.[1];
      const ids = {
        'Suggest only': 'suggest-only',
        'Preview and approve (default)': 'preview-and-approve',
        'Apply safe changes': 'auto-apply-low-risk',
        'Work on its own': 'full-auto-limited',
      };
      return ids[mode] === this.app.state.mode
        ? 'joy-settings-mode-card is-selected'
        : 'joy-settings-mode-card';
    }
    return null;
  }

  async evaluate(read) {
    // A control that reads its options: a slot's profile list offers the one saved connection and
    // its model list the stub model. Anything else is asked for its tag name.
    if (String(read ?? '').includes('.options')) {
      return /combobox.* profile/u.test(this.desc) ? ['QA stub'] : ['joy-stub-model'];
    }
    return 'SELECT';
  }
}

export function createFakePage(options = {}) {
  const app = createFakeApp(options);
  const root = new FakeLocator(app, 'page');
  const page = {
    app,
    getByRole: (role, opts) => root.getByRole(role, opts),
    getByText: (value) => root.getByText(value),
    getByPlaceholder: (value) => root.getByPlaceholder(value),
    locator: (selector, opts) => root.locator(selector, opts),
    evaluate: async () => 'frozen',
  };
  return page;
}
