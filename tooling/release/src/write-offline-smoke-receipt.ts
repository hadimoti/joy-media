import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createOfflineSmokeReceipt,
  localOfflineSmokeRunWindow,
  validateOfflineSmokeReceipt,
  type OfflineSmokeReceiptContext,
  type OfflineSmokeRunEvidence,
} from './offline-smoke-receipt.ts';
import { validateSandboxLifecycle } from './sandbox-lifecycle-receipt.ts';

const FLAGS = ['context', 'evidence', 'network-log', 'lifecycle', 'output'] as const;

function parseArgs(argv: readonly string[]): Record<string, string> | string {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      return 'expected --name value pairs';
    }
    const name = key.slice(2);
    if (!(FLAGS as readonly string[]).includes(name)) return 'unknown option: ' + key;
    values[name] = value;
  }
  for (const flag of FLAGS) {
    if (values[flag] === undefined) return 'missing --' + flag;
  }
  return values;
}

function readJson<T>(path: string): T {
  const text = readFileSync(resolve(path), 'utf8');
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(json) as T;
}

function main(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(parsed + '\n');
    return 2;
  }

  try {
    const context = readJson<OfflineSmokeReceiptContext>(parsed.context!);
    const evidence = readJson<OfflineSmokeRunEvidence>(parsed.evidence!);
    const lifecycleRaw = readFileSync(resolve(parsed.lifecycle!), 'utf8');
    const lifecycleText =
      lifecycleRaw.charCodeAt(0) === 0xfeff ? lifecycleRaw.slice(1) : lifecycleRaw;
    const lifecycle = JSON.parse(lifecycleText) as unknown;
    const setupSha256 = context.artifactSha256;
    const lifecycleReasons = validateSandboxLifecycle(lifecycle, { setupSha256 });
    if (lifecycleReasons.length > 0) {
      for (const reason of lifecycleReasons)
        process.stderr.write('sandbox-lifecycle: ' + reason + '\n');
      return 1;
    }

    const networkLog = readFileSync(resolve(parsed['network-log']!), 'utf8');
    const receipt = createOfflineSmokeReceipt(context, evidence, networkLog);
    const outcome = validateOfflineSmokeReceipt(receipt, {
      candidateSha: context.candidateSha,
      artifactName: context.artifactName,
      artifactSha256: context.artifactSha256,
      runWindow: localOfflineSmokeRunWindow(context, evidence),
    });
    if (!outcome.ok) {
      for (const reason of outcome.reasons) process.stderr.write('offline-smoke: ' + reason + '\n');
      return 1;
    }
    writeFileSync(resolve(parsed.output!), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    process.stdout.write('Sandbox lifecycle and offline-smoke receipts accepted.\n');
    return 0;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
