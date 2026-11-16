import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildSettingsFlowScript,
  DEFAULT_PLAN_OPERATIONS,
} from '../stub-model/settings-flow-script.mjs';
import { createFakePage } from './provider-settings-fake-page.mjs';
import * as providerSettingsSteps from './provider-settings-steps.mjs';
import {
  assertRendererProposalArguments,
  loadRendererProposalContract,
} from '../stub-model/renderer-proposal-contract.mjs';
import {
  assertNoSecret,
  CONSENT_TEXT,
  checkModeOutcome,
  classifyOutcome,
  EXECUTION_MODES,
  PROVIDER_SETTINGS_CASES,
  PROVIDER_SETTINGS_ORDER,
  runInModes,
} from './provider-settings-steps.mjs';

const CTX = {
  baseUrl: 'http://127.0.0.1:47123/v1',
  model: 'joy-stub-model',
  apiKey: 'joy-stub-key-00000000-test',
  timeoutMs: 300,
};

async function runAll(page, ctx = CTX) {
  const outcomes = {};
  for (const id of PROVIDER_SETTINGS_ORDER) {
    outcomes[id] = await PROVIDER_SETTINGS_CASES[id](page, ctx);
  }
  return outcomes;
}

test('the cases cover the five matrix rows in a fixed order', () => {
  assert.deepEqual(PROVIDER_SETTINGS_ORDER, [
    'D-088a',
    'D-087',
    'D-088',
    'D-089',
    'D-087c',
    'D-090',
    'D-090c',
    'D-091',
    'D-087r',
  ]);
  for (const id of ['D-087', 'D-088', 'D-089', 'D-090', 'D-091']) {
    assert.equal(typeof PROVIDER_SETTINGS_CASES[id], 'function', id);
  }
  assert.deepEqual(
    EXECUTION_MODES.map((mode) => mode.id),
    ['suggest-only', 'preview-and-approve', 'auto-apply-low-risk', 'full-auto-limited'],
  );
});

test('a full dry run passes every case on the fake page', async () => {
  const page = createFakePage();
  const outcomes = await runAll(page);
  assert.equal(page.app.state.endpointOpen, true, 'the endpoint form accordion is open');
  assert.match(outcomes['D-088a'], /Refresh models is disabled/);
  assert.match(outcomes['D-088'], /Image Supported/);
  assert.match(outcomes['D-089'], /Workhorse, Creative Brain/);
  assert.equal(outcomes['D-090'].results.length, 4);
  const [suggest, preview] = outcomes['D-090'].results;
  assert.equal(suggest.afterApproval.clips, suggest.baselineClips);
  assert.equal(preview.staged.clips, preview.baselineClips, 'the preview must not write');
  assert.equal(preview.afterApproval.clips, preview.baselineClips + 1);
  assert.equal(preview.afterUndo.clips, preview.baselineClips);
  assert.equal(page.app.state.profiles, 0, 'the profile is removed at the end');
  assert.equal(page.app.state.clips, 1, 'the timeline is back where it started');
});

test('model discovery and slot profile selection use their visible app containers', async () => {
  const page = createFakePage();
  await PROVIDER_SETTINGS_CASES['D-088a'](page, CTX);
  await PROVIDER_SETTINGS_CASES['D-087'](page, CTX);
  await PROVIDER_SETTINGS_CASES['D-088'](page, CTX);
  await PROVIDER_SETTINGS_CASES['D-089'](page, CTX);
  const modelLookup = page.app.calls.find(
    ([kind, desc]) =>
      kind === 'click' && desc.includes('css[.joy-own-key]') && desc.includes('Find models'),
  );
  assert.ok(modelLookup, 'Find models is scoped to the own endpoint form');
  assert.ok(
    page.app.calls.some(
      ([kind, desc]) => kind === 'click' && desc.includes('Models found on this service'),
    ),
    'the fetched model is read from the visible model drawer',
  );
  const profileChoices = page.app.calls.filter(
    ([kind, desc]) => kind === 'selectOption' && desc.includes('profile'),
  );
  assert.equal(profileChoices.length, 2);
  assert.ok(
    profileChoices.every(
      ([, desc]) => desc.includes('Workhorse profile') || desc.includes('Creative Brain profile'),
    ),
  );
});

test('the dry run presses the consent before connecting and presses Undo run after approving', async () => {
  const page = createFakePage();
  await runAll(page);
  const clicks = page.app.calls.filter(([kind]) => kind === 'click').map(([, desc]) => desc);
  const firstConnect = clicks.findIndex((desc) => desc.includes('Connect model'));
  const firstConsent = page.app.calls.findIndex(([kind]) => kind === 'check');
  assert.ok(firstConnect >= 0 && firstConsent >= 0);
  assert.ok(clicks.some((desc) => desc.includes('Approve & apply')));
  assert.ok(
    clicks.findIndex((desc) => desc.includes('Undo run')) >
      clicks.findIndex((desc) => desc.includes('Approve & apply')),
  );
});

test('a preview that writes before approval fails D-090', async () => {
  const page = createFakePage({ previewWrites: true });
  await assert.rejects(async () => {
    await runAll(page);
  }, /preview wrote to the timeline/);
});

test('a D-090 run fails when the model replies without staging a proposal', async () => {
  const page = createFakePage({ noProposalMode: 'auto-apply-low-risk' });
  await assert.rejects(
    () => PROVIDER_SETTINGS_CASES['D-090'](page, CTX),
    /Apply safe changes: no proposal card/u,
  );
  assert.equal(page.app.state.mode, 'auto-apply-low-risk');
  assert.equal(
    page.app.state.clips,
    1,
    'the earlier preview was undone before the missing proposal',
  );
});

test('D-090 will not approve when an approval button appears without a proposal card', async () => {
  const page = createFakePage({ orphanApprovalMode: 'preview-and-approve' });
  await assert.rejects(() => runInModes(page, CTX), /no proposal card appeared before approval/u);
  const clicks = page.app.calls.filter(([kind]) => kind === 'click').map(([, desc]) => desc);
  assert.equal(
    clicks.some((desc) => desc.includes('Approve & apply')),
    false,
  );
});

test('Suggest only that applies an edit fails D-090', async () => {
  const page = createFakePage({ suggestOnlyApplies: true });
  await assert.rejects(async () => {
    await runAll(page);
  }, /Suggest only/);
});

test('automatic modes that apply on their own are accepted, with Undo run', async () => {
  const page = createFakePage({ autoModesApply: true });
  const outcomes = await runAll(page);
  const auto = outcomes['D-090'].results.find((entry) => entry.mode === 'auto-apply-low-risk');
  assert.equal(auto.staged.outcome, 'applied');
  assert.equal(auto.afterUndo.clips, auto.baselineClips);
});

test('editing the public URL must clear the consent (D-091)', async () => {
  const page = createFakePage({ keepConsentOnEdit: true });
  await assert.rejects(async () => {
    await PROVIDER_SETTINGS_CASES['D-091'](page, CTX);
  }, /did not clear the consent/);
  const clean = createFakePage();
  const message = await PROVIDER_SETTINGS_CASES['D-091'](clean, CTX);
  assert.match(message, /nothing was sent/);
  assert.equal(clean.app.state.consentTicked, false);
  assert.ok(CONSENT_TEXT.length > 0);
});

test('a run that is cancelled leaves the timeline as it was (D-090c)', async () => {
  const page = createFakePage();
  const message = await PROVIDER_SETTINGS_CASES['D-090c'](page, CTX);
  assert.match(message, /run cancelled/);
  assert.equal(page.app.state.cancelled, true);
  assert.ok(
    page.app.calls.some(
      ([kind, desc]) => kind === 'click' && desc.includes('Stop (agent|current plan)'),
    ),
    'the Stop action is clicked',
  );
});

test('D-090 reports the app safe-stop state instead of waiting for a run card', async () => {
  const page = createFakePage({ safeStopMode: 'preview-and-approve' });
  await assert.rejects(
    () => runInModes(page, CTX),
    /Preview and approve \(default\): the app reported "Joy Code could not finish this run safely\. No edits were applied\."/u,
  );
});

test('classifyOutcome waits for two new messages and ignores a reverted run card', () => {
  const idle = {
    thinking: false,
    approve: false,
    applyEdit: false,
    lastRun: false,
    reverted: false,
    liveProposal: false,
    plan: false,
    messages: 4,
  };
  assert.equal(classifyOutcome({ ...idle, messages: 5 }, 4), 'waiting');
  assert.equal(classifyOutcome({ ...idle, messages: 6 }, 4), 'reply');
  assert.equal(classifyOutcome({ ...idle, approve: true }, 4), 'proposal');
  assert.equal(classifyOutcome({ ...idle, lastRun: true, reverted: true }, 4), 'waiting');
  assert.equal(classifyOutcome({ ...idle, lastRun: true }, 4), 'applied');
  assert.equal(classifyOutcome({ ...idle, thinking: true, approve: true }, 4), 'waiting');
});

test('checkModeOutcome names the broken promise of each mode', () => {
  const base = { clips: 1, approve: false, applyEdit: false, undo: false };
  assert.equal(checkModeOutcome('suggest-only', 'reply', base, 1), undefined);
  assert.match(
    checkModeOutcome('suggest-only', 'reply', { ...base, clips: 2 }, 1),
    /changed the timeline/,
  );
  assert.match(
    checkModeOutcome('suggest-only', 'proposal', { ...base, approve: true }, 1),
    /offered to apply/,
  );
  assert.equal(
    checkModeOutcome('preview-and-approve', 'proposal', { ...base, approve: true }, 1),
    undefined,
  );
  assert.match(checkModeOutcome('preview-and-approve', 'reply', base, 1), /expected a proposal/);
  assert.match(
    checkModeOutcome('full-auto-limited', 'applied', { ...base, clips: 2 }, 1),
    /no Undo run/,
  );
});

test('assertNoSecret fails when the key is in a reply and passes when it is not', () => {
  const leaky = createFakePage({ leakKeyInReply: true });
  return (async () => {
    await PROVIDER_SETTINGS_CASES['D-088a'](leaky, CTX);
    await PROVIDER_SETTINGS_CASES['D-087'](leaky, CTX);
    assert.throws(() => assertNoSecret(CTX.apiKey, leaky.app.state.ipc), /stub key appears/);
    const clean = createFakePage();
    await PROVIDER_SETTINGS_CASES['D-087'](clean, CTX);
    assert.equal(assertNoSecret(CTX.apiKey, clean.app.state.ipc), clean.app.state.ipc.length);
    assert.throws(() => assertNoSecret('short', []), /too short/);
  })();
});

test('evidence scan covers every text artifact and ignores binary screenshots', async () => {
  const scanEvidenceForSecret = providerSettingsSteps.scanEvidenceForSecret;
  assert.equal(typeof scanEvidenceForSecret, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'joy-stub-evidence-'));
  const artifacts = [
    join(directory, 'summary.json'),
    join(directory, 'D-087', 'result.json'),
    join(directory, 'stub-requests.ndjson'),
    join(directory, 'ipc-replies.ndjson'),
  ];
  await mkdir(join(directory, 'D-087'), { recursive: true });
  await Promise.all(artifacts.map((path) => writeFile(path, 'clean')));
  await writeFile(join(directory, 'D-087', 'screenshot.png'), Buffer.from(CTX.apiKey));
  try {
    const clean = await scanEvidenceForSecret(CTX.apiKey, directory);
    assert.equal(clean.filesScanned, artifacts.length);
    for (const path of artifacts) {
      await writeFile(path, `contains ${CTX.apiKey}`);
      await assert.rejects(() => scanEvidenceForSecret(CTX.apiKey, directory), /stub key appears/u);
      await writeFile(path, 'clean');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the real stub server accepts the script and answers the app probe shapes from it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'joy-stub-flow-'));
  const scriptPath = join(directory, 'script.json');
  await writeFile(scriptPath, JSON.stringify(buildSettingsFlowScript()));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../stub-model/server.mjs', import.meta.url)),
      '--port',
      '0',
      '--script',
      scriptPath,
      '--log',
      join(directory, 'log.ndjson'),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(async () => {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    child.once('exit', () => reject(new Error('the stub exited before it was ready')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => resolve(JSON.parse(chunk.split('\n')[0])));
  });
  const ask = async (messages, tools) => {
    const response = await globalThis.fetch(`${ready.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ready.model, messages, ...(tools ? { tools } : {}) }),
    });
    return (await response.json()).choices[0].message;
  };
  const probeTools = [{ type: 'function', function: { name: 'joy_probe', parameters: {} } }];
  const rendererContract = await loadRendererProposalContract();
  const planTools = [
    rendererContract.readProjectContextTool,
    rendererContract.validateProposalTool,
  ];
  const probe = await ask(
    [
      {
        role: 'user',
        content: 'Use the joy_probe tool exactly once with {}. After its result, reply.',
      },
    ],
    probeTools,
  );
  assert.equal(probe.tool_calls[0].function.name, 'joy_probe');
  const continued = await ask(
    [
      { role: 'user', content: 'Use the joy_probe tool exactly once with {}.' },
      { role: 'assistant', content: null, tool_calls: probe.tool_calls },
      { role: 'tool', tool_call_id: 'call-joy-probe', content: 'ok' },
    ],
    probeTools,
  );
  assert.equal(continued.content, 'JOY_PROVIDER_PROBE_CONTINUED_V1');
  const media = await ask([
    {
      role: 'user',
      content: [
        { type: 'text', text: "This is JOY's synthetic video capability test. Reply." },
        { type: 'video_url', video_url: { url: 'data:video/webm;base64,AA==' } },
      ],
    },
  ]);
  assert.equal(media.content, 'JOY_MEDIA_CAPABILITY_PROBE_OK_V1');
  const planRequest = [{ role: 'user', content: 'STUB-PLAN preview-and-approve' }];
  const context = await ask(planRequest, planTools);
  assert.equal(context.tool_calls[0].function.name, 'read_project_context');
  const plan = await ask(
    [
      ...planRequest,
      { role: 'assistant', content: null, tool_calls: context.tool_calls },
      { role: 'tool', tool_call_id: 'call-stub-context', content: '{"domain":"overview"}' },
    ],
    planTools,
  );
  assert.equal(plan.tool_calls[0].function.name, rendererContract.proposalToolName);
  const proposalArgs = JSON.parse(plan.tool_calls[0].function.arguments);
  assert.doesNotThrow(() => assertRendererProposalArguments(rendererContract, proposalArgs));
  const closing = await ask(
    [
      ...planRequest,
      { role: 'assistant', content: null, tool_calls: context.tool_calls },
      { role: 'tool', tool_call_id: 'call-stub-context', content: '{"domain":"overview"}' },
      { role: 'assistant', content: null, tool_calls: plan.tool_calls },
      { role: 'tool', tool_call_id: 'call-stub-plan', content: '{}' },
    ],
    planTools,
  );
  assert.equal(closing.content, 'Staged the edit.');
});

test('the stub script uses the renderer proposal tool and validates its real arguments', async () => {
  const rendererContract = await loadRendererProposalContract();
  const script = buildSettingsFlowScript({ model: 'joy-stub-model' });
  assert.equal(script.model, 'joy-stub-model');
  const matched = script.responses.filter((entry) => entry.match !== undefined);
  assert.ok(matched.every((entry) => entry.reusable === true));
  assert.ok(rendererContract.hostToolNames.includes(rendererContract.proposalToolName));
  const planned = script.responses.find((entry) =>
    entry.tool_calls?.some((call) => call.function.name === rendererContract.proposalToolName),
  );
  assert.ok(planned, 'the stub script includes a renderer proposal response');
  const args = JSON.parse(planned.tool_calls[0].function.arguments);
  assert.equal(planned.tool_calls[0].function.name, rendererContract.proposalToolName);
  assert.deepEqual(args.operations, [...DEFAULT_PLAN_OPERATIONS]);
  assert.equal(args.operations[0].assetId, rendererContract.rendererFixtureAssetId);
  assert.doesNotThrow(() => assertRendererProposalArguments(rendererContract, args));
  const slow = script.responses.find((entry) => entry.match?.user_includes === 'STUB-SLOW');
  assert.ok(slow.delay_ms >= 3000 && slow.delay_ms <= 5000);
  const ownOperations = [{ ...DEFAULT_PLAN_OPERATIONS[0], startUs: 2_000_000 }];
  const own = buildSettingsFlowScript({ planOperations: ownOperations });
  assert.deepEqual(
    JSON.parse(
      own.responses.find((entry) => entry.match?.tool === 'validate_proposal').tool_calls[0]
        .function.arguments,
    ).operations,
    ownOperations,
  );
  const imageProbe = script.responses.find(
    (entry) => entry.match?.user_includes === 'synthetic image capability test',
  );
  const audioProbe = script.responses.find(
    (entry) => entry.match?.user_includes === 'synthetic audio capability test',
  );
  const videoProbe = script.responses.find(
    (entry) => entry.match?.user_includes === 'synthetic video capability test',
  );
  assert.equal(imageProbe.content, 'JOY_MEDIA_CAPABILITY_PROBE_OK_V1');
  assert.ok(audioProbe, 'the stub script has an audio-specific response');
  assert.equal(audioProbe.error.code, 'unsupported_media');
  assert.equal(videoProbe.content, 'JOY_MEDIA_CAPABILITY_PROBE_OK_V1');
});
