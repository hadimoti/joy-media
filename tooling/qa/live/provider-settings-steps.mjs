/* global window */
/**
 * T-A11 driver cases: Joy Code settings, providers and agent slots on the local stub model.
 *
 * Designed for a running app through the T-A02 driver (`driver.mjs`): each case takes the
 * Playwright `page` of a live session that has a project open, and a context
 * `{ baseUrl, model, apiKey }` for the stub of `tooling/qa/stub-model/server.mjs` started with
 * the script of `settings-flow-script.mjs`. Not wired into `run.mjs` (that file belongs to
 * T-A02); `provider-settings-run.mjs` runs them by id, or in dry-run mode on a fake page.
 *
 * Cases (D-087 to D-091 are the rows of docs/qa/v1.1.1/TEST-MATRIX.md section 3.7; the lettered
 * ids are parts of those rows that need their own evidence):
 *   D-088a  The model drawer before any connection exists, and Refresh models while disabled.
 *   D-087   Add the stub as an OpenAI-compatible profile: consent first, then the profile.
 *   D-088   Fetch the models, then Check media support.
 *   D-089   Set both agent slots, press Refresh models, and use each slot for the agent.
 *   D-087c  Chat, so the stub's reply shows in Joy Code.
 *   D-090   The same instruction in each of the four execution modes, with Undo run.
 *   D-090c  Cancel a run that is waiting on the model.
 *   D-091   The public-endpoint consent flow: decline, accept, edit the URL.
 *   D-087r  Remove the stub profile.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { openMenu } from './steps.mjs';

export const CONSENT_TEXT =
  'I understand that custom endpoints may log requests according to their own policy.';
export const PUBLIC_ENDPOINT_URL = 'https://stub-public.invalid/v1';
export const CONNECTION_NAME = 'QA stub';

export const EXECUTION_MODES = Object.freeze([
  { id: 'suggest-only', name: 'Suggest only' },
  { id: 'preview-and-approve', name: 'Preview and approve (default)' },
  { id: 'auto-apply-low-risk', name: 'Apply safe changes' },
  { id: 'full-auto-limited', name: 'Work on its own' },
]);

const TIMELINE_CLIP = '.timeline-clip[data-clip-id]';

/** Every locator the cases use, in one place, so a changed label is fixed once. */
export const ui = {
  dialog: (page) => page.getByRole('dialog', { name: 'Joy Code Settings', exact: true }),
  gear: (page) => page.getByRole('button', { name: 'Joy Code Settings', exact: true }).first(),
  close: (page) => page.getByRole('button', { name: 'Close settings', exact: true }),
  nav: (dialog, name) => dialog.getByRole('button', { name, exact: true }),
  providerSelect: (dialog) => dialog.locator('.joy-own-key select').first(),
  endpointAccordion: (dialog) =>
    dialog.getByRole('button', { name: /Connection and sign-in/u }).first(),
  nameInput: (dialog) => dialog.getByPlaceholder('e.g. My OpenRouter, Local Ollama'),
  addressInput: (dialog) => dialog.getByPlaceholder('https://...'),
  keyInput: (dialog) => dialog.locator('.joy-own-key input[type="password"]'),
  consent: (dialog) => dialog.getByRole('checkbox', { name: CONSENT_TEXT }),
  modelIdInput: (dialog) => dialog.getByRole('textbox', { name: 'Model ID', exact: true }),
  findModels: (dialog) =>
    dialog.locator('.joy-own-key').getByRole('button', { name: 'Find models', exact: true }),
  showModelList: (dialog) =>
    dialog.locator('.joy-own-key').getByRole('button', { name: 'Show model list', exact: true }),
  modelDrawer: (dialog) => dialog.getByRole('button', { name: /Models found on this service/u }),
  connect: (dialog) => dialog.getByRole('button', { name: 'Connect model', exact: true }),
  modelChip: (dialog, model) => dialog.locator('.joy-settings-model-chip', { hasText: model }),
  checkMedia: (dialog) => dialog.getByRole('button', { name: 'Check media support', exact: true }),
  mediaGrid: (dialog) => dialog.locator('.joy-settings-probe-grid'),
  slotCards: (dialog) => dialog.locator('article.agent-slot-card'),
  removeProfile: (dialog) => dialog.getByRole('button', { name: /^Remove .* profile$/ }),
  modeCard: (page, dialog, name) =>
    dialog
      .locator('.joy-settings-mode-card')
      .filter({ has: page.getByText(name, { exact: true }) }),
  composer: (page) => page.getByRole('textbox', { name: 'Message Joy Code', exact: true }),
  clips: (page) => page.locator(TIMELINE_CLIP),
  approve: (page) => page.getByRole('button', { name: /Approve & apply/u }),
  applyEdit: (page) => page.getByRole('button', { name: /Apply edit/u }),
  reject: (page) => page.getByRole('button', { name: /^Reject$/u }),
  undoRun: (page) => page.getByRole('button', { name: /Undo run/u }),
  // The send button turns into this while a run is busy (AgentPanel.tsx aria-label).
  stop: (page) => page.getByRole('button', { name: 'Stop current plan', exact: true }),
  safeStop: (page) =>
    page.getByText('Joy Code could not finish this run safely.', { exact: false }),
  liveProposal: (page) => page.locator('[aria-label="JOY Agent live proposal"]'),
  plan: (page) => page.locator('[aria-label="Proposed timeline plan"]'),
  lastRun: (page) => page.locator('[aria-label="Last Joy Code run"]'),
  thinking: (page) => page.locator('[aria-label="Joy Code is thinking"]'),
  messages: (page) => page.locator('.joy-code-message'),
};

async function waitUntil(check, { timeoutMs, message, intervalMs = 200 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function expectVisible(locator, what, timeout = 15_000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error(`expected to see: ${what}`);
  }
}

async function expectHidden(locator, what, timeout = 15_000) {
  try {
    await locator.waitFor({ state: 'hidden', timeout });
  } catch {
    throw new Error(`expected not to see: ${what}`);
  }
}

// ----- opening and closing ----------------------------------------------------------------

/** Opens the Joy Code panel through the Joy Code menu when its composer is not on screen. */
export async function openJoyCode(page) {
  if (await ui.composer(page).isVisible()) return;
  await openMenu(page, 'Joy Code');
  await page.getByRole('menuitem', { name: /Open Joy Code/u }).click();
  await expectVisible(ui.composer(page), 'the Joy Code composer');
}

/** Opens Joy Code Settings on the AI models page (or the page named) and returns the dialog. */
export async function openSettings(page, pageName = 'AI models') {
  await openJoyCode(page);
  const dialog = ui.dialog(page);
  if (!(await dialog.isVisible())) {
    await ui.gear(page).click();
    await expectVisible(dialog, 'the Joy Code Settings dialog');
  }
  await ui.nav(dialog, pageName).click();
  if (pageName === 'AI models') {
    const endpoint = ui.endpointAccordion(dialog);
    if ((await endpoint.getAttribute('aria-expanded')) !== 'true') await endpoint.click();
  }
  return dialog;
}

export async function closeSettings(page) {
  if (!(await ui.dialog(page).isVisible())) return;
  await ui.close(page).click();
  await expectHidden(ui.dialog(page), 'the Joy Code Settings dialog');
}

async function chooseOwnEndpoint(dialog) {
  await ui.providerSelect(dialog).selectOption('openai-compatible');
}

// ----- D-088a: drawer and Refresh models before connecting --------------------------------

export async function modelDrawerBeforeConnecting(page) {
  const dialog = await openSettings(page);
  // The model list is a separate accordion below the connection form; the form's
  // Show model list control does not exist until that form is populated.
  await ui.modelDrawer(dialog).click();
  await expectVisible(
    dialog.getByText(/No models yet\./u),
    'the empty model drawer before a provider is selected',
  );
  const refresh = ui.slotCards(dialog).first().getByRole('button', {
    name: 'Refresh models',
    exact: true,
  });
  const disabled = await refresh.isDisabled();
  if (!disabled) throw new Error('Refresh models must be disabled before a profile is chosen');
  await closeSettings(page);
  return 'the empty model drawer opens; Workhorse Refresh models is disabled with no profile';
}

// ----- D-087: add the loopback profile -----------------------------------------------------

export async function addLoopbackProfile(page, ctx) {
  const dialog = await openSettings(page);
  await chooseOwnEndpoint(dialog);
  await ui.nameInput(dialog).fill(CONNECTION_NAME);
  await ui.addressInput(dialog).fill(ctx.baseUrl);
  await ui.keyInput(dialog).fill(ctx.apiKey);
  await ui.modelIdInput(dialog).fill(ctx.model);
  await expectVisible(dialog.getByText(CONSENT_TEXT), 'the consent text');
  // Declined: no acknowledgement yet, so Connect refuses and sends nothing.
  await ui.connect(dialog).click();
  await expectVisible(
    dialog.getByText('Enter the custom-provider acknowledgement before connecting.'),
    'the refusal before the consent is ticked',
  );
  await ui.consent(dialog).check();
  await ui.connect(dialog).click();
  await expectVisible(
    dialog.getByText('Ready to edit your project'),
    'the connected banner (the stub answered the tool probe)',
    45_000,
  );
  await expectVisible(
    dialog.getByText(/Saved connections \(1\)/u),
    'the saved profile in the list',
  );
  return 'consent text shown; refused until ticked; stub connected and listed as one saved connection';
}

// ----- D-088: fetch models and check media support ----------------------------------------

export async function fetchModelsAndCheckMedia(page, ctx) {
  const dialog = await openSettings(page);
  await ui.findModels(dialog).click();
  // The list fills first. The app may open the drawer by itself, so it is opened here only when
  // the model button is not showing (a blind click would close it again).
  await expectVisible(dialog.getByText('1 models ready'), 'the models-ready tag');
  const chip = ui.modelChip(dialog, ctx.model);
  if ((await chip.count()) === 0 || !(await chip.first().isVisible())) {
    await ui.modelDrawer(dialog).click();
  }
  await expectVisible(chip, `the model ${ctx.model} in the list`);
  await waitUntil(async () => !(await ui.checkMedia(dialog).isDisabled()), {
    timeoutMs: 15_000,
    message: 'Check media support to be enabled',
  });
  await ui.checkMedia(dialog).click();
  await expectVisible(
    dialog.getByText(/Media capability check complete for/u),
    'the media check result',
    45_000,
  );
  const grid = await ui.mediaGrid(dialog).innerText();
  if (
    !/Image[\s\S]*Supported/u.test(grid) ||
    !/Audio[\s\S]*Unavailable/u.test(grid) ||
    !/Video[\s\S]*Supported/u.test(grid)
  ) {
    throw new Error(
      `the stub should support image and video but not audio; the grid says: ${grid}`,
    );
  }
  return `model list filled; media check: ${grid.replace(/\s+/gu, ' ').trim()}`;
}

// ----- D-089: both agent slots --------------------------------------------------------------

async function slotLabel(card) {
  return (await card.locator('h4.agent-slot-title').innerText()).trim();
}

export async function setAgentSlots(page, ctx) {
  const dialog = await openSettings(page);
  const cards = ui.slotCards(dialog);
  const count = await cards.count();
  if (count !== 2) throw new Error(`expected 2 agent slots, found ${count}`);
  const labels = [];
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const label = await slotLabel(card);
    labels.push(label);
    // Choosing the one saved profile reads its models at once.
    const profileSelect = card.getByRole('combobox', { name: `${label} profile`, exact: true });
    await expectVisible(profileSelect, `${label} profile list`);
    const offered = await profileSelect.evaluate((node) =>
      node.options === undefined
        ? [`(not a list: <${node.tagName.toLowerCase()}> ${node.outerHTML.slice(0, 160)})`]
        : Array.from(node.options, (option) => option.textContent ?? ''),
    );
    if (!offered.includes(CONNECTION_NAME)) {
      throw new Error(
        `the ${label} profile list does not offer "${CONNECTION_NAME}"; it offers: ${offered.join(' | ')}`,
      );
    }
    try {
      await profileSelect.selectOption({ label: CONNECTION_NAME }, { timeout: 8000 });
    } catch (error) {
      const why = String(error?.message ?? error).replace(/\s+/gu, ' ');
      throw new Error(
        `choosing "${CONNECTION_NAME}" in the ${label} profile list failed: ${why.slice(0, 700)}`,
      );
    }
    const modelControl = card.locator(`[aria-label="${label} model"]`);
    await expectVisible(modelControl, `${label} model control`);
    await waitUntil(async () => !(await modelControl.isDisabled()), {
      timeoutMs: 15_000,
      message: `${label} model control to enable after choosing a profile`,
    });
    // Choosing a profile reads its models, and the control may change from a text box to a list when
    // the reading ends. Let the reading finish first.
    await waitUntil(async () => (await card.getByText(/^Reading the models/u).count()) === 0, {
      timeoutMs: 20_000,
      message: `${label}: the model reading to finish`,
    });
    // The model control is a text box until the profile's models are read, then a list.
    let seen = 'nothing yet';
    try {
      await waitUntil(
        async () => {
          const info = await modelControl
            .evaluate((node) => ({
              tag: node.tagName,
              values: node.options === undefined ? [] : Array.from(node.options, (o) => o.value),
            }))
            .catch(() => undefined);
          if (info !== undefined) seen = `${info.tag}: ${info.values.join(' | ')}`;
          return info?.tag === 'SELECT' && info.values.includes(ctx.model);
        },
        {
          timeoutMs: 20_000,
          message: `the ${label} model list to offer ${ctx.model}`,
        },
      );
    } catch (error) {
      throw new Error(`${error.message}; the control showed ${seen}`);
    }
    try {
      await modelControl.selectOption(ctx.model, { timeout: 8000 });
    } catch (error) {
      const why = String(error?.message ?? error).replace(/\s+/gu, ' ');
      throw new Error(
        `choosing ${ctx.model} in the ${label} model list failed: ${why.slice(0, 700)}`,
      );
    }
    const refresh = card.getByRole('button', { name: 'Refresh models', exact: true });
    await refresh.click();
    await card.getByRole('button', { name: `Save ${label}`, exact: true }).click();
    await expectVisible(card.getByText(`${label} saved.`), `${label} saved line`);
    await card.getByRole('button', { name: 'Use for agent', exact: true }).click();
    await expectVisible(
      card.getByText(`${label} is the connection the agent uses now.`),
      `${label} in use`,
      45_000,
    );
  }
  await closeSettings(page);
  return `both slots set to ${ctx.model}: ${labels.join(', ')}; Refresh models pressed in each`;
}

// ----- chat ---------------------------------------------------------------------------------

/** Types an instruction into the Joy Code composer and sends it. */
export async function sendInstruction(page, text) {
  await openJoyCode(page);
  const composer = ui.composer(page);
  await composer.fill(text);
  await composer.press('Enter');
}

export async function chatWithStub(page) {
  await closeSettings(page);
  await sendInstruction(page, 'STUB-HELLO say hello');
  await expectVisible(
    page.getByText('Hello from the JOY QA stub.'),
    'the stub reply in the Joy Code thread',
    30_000,
  );
  return 'the stub reply shows in the Joy Code thread';
}

// ----- D-090: the four execution modes -------------------------------------------------------

export async function setExecutionMode(page, mode) {
  const dialog = await openSettings(page, 'Safety and limits');
  const card = ui.modeCard(page, dialog, mode.name);
  await card.click();
  const cls = (await card.getAttribute('class')) ?? '';
  if (!cls.includes('is-selected')) throw new Error(`mode ${mode.name} was not selected`);
  await closeSettings(page);
}

async function lastMessageText(page) {
  const messages = ui.messages(page);
  if ((await messages.count()) === 0) return '';
  const text = await messages.nth((await messages.count()) - 1).innerText();
  return String(text).replace(/\s+/gu, ' ').trim().slice(0, 300);
}

/** What the page shows now, as plain numbers and flags. */
export async function readJoyCodeSnapshot(page) {
  return {
    clips: await ui.clips(page).count(),
    liveProposal: (await ui.liveProposal(page).count()) > 0,
    plan: (await ui.plan(page).count()) > 0,
    approve: (await ui.approve(page).count()) > 0,
    applyEdit: (await ui.applyEdit(page).count()) > 0,
    undo: (await ui.undoRun(page).count()) > 0,
    lastRun: (await ui.lastRun(page).count()) > 0,
    reverted: (await page.getByText('Reverted.').count()) > 0,
    thinking: (await ui.thinking(page).count()) > 0,
    messages: await ui.messages(page).count(),
    lastMessage: await lastMessageText(page),
  };
}

/**
 * 'waiting' while the run is busy, 'proposal' when an edit waits for a yes, 'applied', or 'reply'.
 * The user's own message is added at once, so a reply needs two new messages. A run card left
 * from the previous mode that says Reverted is not a new result.
 */
export function classifyOutcome(snapshot, messagesBefore) {
  if (snapshot.thinking) return 'waiting';
  if (snapshot.approve || snapshot.applyEdit) return 'proposal';
  if (snapshot.lastRun && !snapshot.reverted) return 'applied';
  // A visible proposal or plan card is a result: checkModeOutcome judges whether it may offer approval.
  if (snapshot.liveProposal || snapshot.plan) return 'proposal';
  if (snapshot.messages >= messagesBefore + 2) return 'reply';
  return 'waiting';
}

/** The problem a mode's snapshot shows, or undefined. `before` is the clip count before the run. */
export function checkModeOutcome(modeId, outcome, snapshot, before) {
  if (modeId === 'suggest-only') {
    if (snapshot.clips !== before) return 'Suggest only changed the timeline';
    if (snapshot.approve || snapshot.applyEdit) return 'Suggest only offered to apply the edit';
    if (outcome === 'applied') return 'Suggest only applied an edit';
  }
  if (modeId === 'preview-and-approve') {
    if (snapshot.clips !== before) return 'the preview wrote to the timeline before approval';
    if (outcome !== 'proposal') {
      return `expected a proposal to approve, saw: ${outcome}${snapshot.lastMessage ? ` (last message: ${snapshot.lastMessage})` : ''}`;
    }
  }
  if (modeId !== 'suggest-only' && outcome === 'reply') {
    return 'no proposal card was staged';
  }
  if (outcome === 'applied' && snapshot.clips !== before && !snapshot.undo) {
    return 'an applied edit shows no Undo run';
  }
  return undefined;
}

/**
 * A preview that stays staged blocks the next edit with "Review, apply, or reject the current JOY
 * preview". Rejects it so the next run starts clean. True when one was there.
 */
export async function rejectLeftoverPreview(page) {
  if ((await ui.reject(page).count()) === 0) return false;
  await ui.reject(page).first().click();
  await waitUntil(async () => (await ui.reject(page).count()) === 0, {
    timeoutMs: 15_000,
    message: 'the staged preview to be rejected',
  });
  return true;
}

export async function runInModes(page, ctx) {
  const timeoutMs = ctx.timeoutMs ?? 60_000;
  await closeSettings(page);
  const results = [];
  for (const mode of EXECUTION_MODES) {
    await setExecutionMode(page, mode);
    const baseline = await readJoyCodeSnapshot(page);
    await sendInstruction(page, `STUB-PLAN ${mode.id}`);
    let outcome = 'waiting';
    let staged = baseline;
    await waitUntil(
      async () => {
        staged = await readJoyCodeSnapshot(page);
        outcome = classifyOutcome(staged, baseline.messages);
        return outcome !== 'waiting' || (await ui.safeStop(page).count()) > 0;
      },
      { timeoutMs, message: `${mode.name}: the run to reach a result` },
    );
    if ((await ui.safeStop(page).count()) > 0) {
      throw new Error(
        `${mode.name}: the app reported "Joy Code could not finish this run safely. No edits were applied."`,
      );
    }
    // The proposal card draws a moment after the model's closing message, so a plain reply is not final yet.
    if (outcome === 'reply') {
      await waitUntil(
        async () => {
          staged = await readJoyCodeSnapshot(page);
          outcome = classifyOutcome(staged, baseline.messages);
          return outcome !== 'reply';
        },
        { timeoutMs: 12_000, message: `${mode.name}: a proposal card after the reply` },
      ).catch(() => undefined);
    }
    const problem = checkModeOutcome(mode.id, outcome, staged, baseline.clips);
    if (problem) throw new Error(`${mode.name}: ${problem}`);
    const entry = { mode: mode.id, baselineClips: baseline.clips, staged: { outcome, ...staged } };
    // A preview that stays staged (Suggest only offers nothing to approve) blocks the next edit.
    if (outcome !== 'proposal') entry.rejectedLeftoverPreview = await rejectLeftoverPreview(page);

    if (outcome === 'proposal') {
      if (!staged.liveProposal && !staged.plan) {
        throw new Error(`${mode.name}: no proposal card appeared before approval`);
      }
      if (staged.approve) await ui.approve(page).click();
      else await ui.applyEdit(page).click();
      await expectVisible(ui.lastRun(page).first(), `${mode.name}: the run card after approval`);
    }
    const after = await readJoyCodeSnapshot(page);
    entry.afterApproval = after;
    if (outcome !== 'reply') {
      if (after.clips <= baseline.clips) {
        throw new Error(`${mode.name}: approving did not add a clip`);
      }
      await ui.undoRun(page).click();
      await expectVisible(page.getByText('Reverted.'), `${mode.name}: Reverted after Undo run`);
      const undone = await readJoyCodeSnapshot(page);
      entry.afterUndo = undone;
      if (undone.clips !== baseline.clips) {
        throw new Error(
          `${mode.name}: Undo run left ${undone.clips} clips, expected ${baseline.clips}`,
        );
      }
    }
    results.push(entry);
  }
  return { message: `ran ${results.length} modes`, results };
}

export async function cancelRun(page, ctx) {
  await closeSettings(page);
  await rejectLeftoverPreview(page);
  await setExecutionMode(page, EXECUTION_MODES[1]);
  const baseline = await readJoyCodeSnapshot(page);
  await sendInstruction(page, 'STUB-SLOW wait for me');
  await waitUntil(async () => (await ui.stop(page).count()) > 0, {
    timeoutMs: ctx.timeoutMs ?? 30_000,
    message: 'the Stop button while the run waits on the stub',
  });
  await ui.stop(page).click();
  await expectVisible(
    page.getByText('JOY run cancelled. No edits were applied.'),
    'the cancelled line',
  );
  const after = await readJoyCodeSnapshot(page);
  if (after.clips !== baseline.clips) throw new Error('a cancelled run changed the timeline');
  return `run cancelled while waiting; clips stayed at ${after.clips}`;
}

// ----- D-091: public endpoint consent ---------------------------------------------------------

export async function publicEndpointConsent(page) {
  const dialog = await openSettings(page);
  await chooseOwnEndpoint(dialog);
  await ui.addressInput(dialog).fill(PUBLIC_ENDPOINT_URL);
  await ui.modelIdInput(dialog).fill('any-model');
  await ui.keyInput(dialog).fill('not-sent');
  await expectVisible(dialog.getByText(CONSENT_TEXT), 'the consent text for a public URL');
  const consent = ui.consent(dialog);
  if (await consent.isChecked()) throw new Error('consent must start unticked');
  const refusal = 'Enter the custom-provider acknowledgement before connecting.';
  // Declined: Connect refuses before any request. The public consent row only
  // needs to prove the acknowledgement and URL-edit behavior.
  await ui.connect(dialog).click();
  await expectVisible(dialog.getByText(refusal), 'the refusal while consent is not given');
  // Accepted.
  await consent.check();
  if (!(await consent.isChecked())) throw new Error('consent did not tick');
  // Edited URL: the consent clears and the refusal comes back.
  await ui.addressInput(dialog).fill(`${PUBLIC_ENDPOINT_URL}x`);
  if (await consent.isChecked()) throw new Error('editing the URL did not clear the consent');
  await ui.connect(dialog).click();
  await expectVisible(dialog.getByText(refusal), 'the refusal after the URL was edited');
  // Leave the form clean: the key field must not keep what was typed.
  await ui.keyInput(dialog).fill('');
  await closeSettings(page);
  return 'public URL: refused when declined, ticked when accepted, cleared and refused again after the URL changed; nothing was sent';
}

// ----- D-087r: remove the profile -------------------------------------------------------------

export async function removeStubProfile(page) {
  const dialog = await openSettings(page);
  await ui.removeProfile(dialog).first().click();
  await expectHidden(dialog.getByText(/Saved connections/u), 'the saved connections list');
  await closeSettings(page);
  return 'the stub profile was removed; no saved connections remain';
}

// ----- IPC capture (best effort) ---------------------------------------------------------------

/**
 * Records the replies (never the requests, which carry the key) of `window.joyDesktop.invoke`.
 * The preload bridge may be frozen; the result says whether the wrapper took hold.
 */
export async function installIpcCapture(page) {
  return page.evaluate(() => {
    const bridge = window.joyDesktop;
    if (!bridge || typeof bridge.invoke !== 'function') return 'no-bridge';
    if (window.__joyQaIpc) return 'already-installed';
    const log = [];
    const original = bridge.invoke.bind(bridge);
    const wrapped = async (channel, payload) => {
      const reply = await original(channel, payload);
      try {
        log.push(JSON.stringify({ channel, reply }));
      } catch {
        log.push(JSON.stringify({ channel, reply: '[unserialisable]' }));
      }
      return reply;
    };
    try {
      bridge.invoke = wrapped;
    } catch {
      return 'frozen';
    }
    if (bridge.invoke !== wrapped) return 'frozen';
    window.__joyQaIpc = log;
    return 'installed';
  });
}

export async function collectIpc(page) {
  return page.evaluate(() => window.__joyQaIpc ?? []);
}

/** Throws when the secret appears in any of the texts. Returns how many texts were checked. */
export function assertNoSecret(secret, texts) {
  if (typeof secret !== 'string' || secret.length < 8)
    throw new Error('the secret to look for is too short');
  const leaks = texts.filter((text) => String(text).includes(secret));
  if (leaks.length > 0) throw new Error(`the stub key appears in ${leaks.length} captured text(s)`);
  return texts.length;
}

/** Scans every text evidence artifact that may contain captured requests or replies. */
export async function scanEvidenceForSecret(secret, evidenceDirectory) {
  assertNoSecret(secret, []);
  const names = new Set([
    'summary.json',
    'result.json',
    'stub-requests.ndjson',
    'ipc-replies.ndjson',
  ]);
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && names.has(entry.name)) files.push(path);
    }
  }
  await walk(evidenceDirectory);
  files.sort();
  const texts = await Promise.all(files.map((path) => readFile(path, 'utf8')));
  const leakedFiles = files.filter((_, index) => texts[index].includes(secret));
  if (leakedFiles.length > 0) {
    const locations = leakedFiles.map((path) => relative(evidenceDirectory, path)).join(', ');
    throw new Error(`the stub key appears in ${leakedFiles.length} evidence file(s): ${locations}`);
  }
  return { filesScanned: files.length };
}

/** The cases by id, and the order a full run takes. */
export const PROVIDER_SETTINGS_CASES = {
  'D-088a': modelDrawerBeforeConnecting,
  'D-087': addLoopbackProfile,
  'D-088': fetchModelsAndCheckMedia,
  'D-089': setAgentSlots,
  'D-087c': chatWithStub,
  'D-090': runInModes,
  'D-090c': cancelRun,
  'D-091': publicEndpointConsent,
  'D-087r': removeStubProfile,
};

export const PROVIDER_SETTINGS_ORDER = Object.freeze(Object.keys(PROVIDER_SETTINGS_CASES));
