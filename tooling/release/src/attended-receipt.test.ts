import { describe, expect, it } from 'vitest';
import {
  ATTENDED_RECEIPT_SCHEMA,
  ATTENDED_SCENARIOS,
  JOY_KEY_EXPECTED_SHA256,
  REQUIRED_ATTENDED_CHECKS,
  assertAttendedReceipt,
  validateAttendedReceipt,
  type AttendedCheck,
  type AttendedReceipt,
  type AttendedScenarioId,
} from './attended-receipt.ts';

const CANDIDATE = 'ded976c8b4fe10c0316e5071ece535ba181707e9';
const EXE_SHA256 = 'd1e7e6978ef4ae5a118580bd016461d2169213f88393c4002041dd7bd9cddbc1';
const DIGEST = 'a'.repeat(64);

type Mutable = { [key: string]: unknown };

function validReceipt(scenarioId: AttendedScenarioId): AttendedReceipt {
  return {
    schema: ATTENDED_RECEIPT_SCHEMA,
    scenario: { id: scenarioId, status: 'passed', firstAttemptPassed: true, retries: 0 },
    candidateSha: CANDIDATE,
    app: { exeSha256: EXE_SHA256, unpackedDir: 'C:\\jgp\\attended-ded976c8-20261109\\app' },
    run: {
      id: '2b0f6c7e-3c1d-4f5a-9d2e-6a8b7c9d0e1f',
      attempt: 1,
      startedAt: '2026-11-09T10:00:00.000Z',
      finishedAt: '2026-11-09T10:05:00.000Z',
      operator: 'owner-at-pc',
      mode: 'scripted',
      manual: false,
    },
    guards: {
      joyKeyBefore: JOY_KEY_EXPECTED_SHA256,
      joyKeyAfter: JOY_KEY_EXPECTED_SHA256,
      ownerLibraryFilesBefore: 3221,
      ownerLibraryFilesAfter: 3221,
      installedFolderTouched: false,
    },
    checks: REQUIRED_ATTENDED_CHECKS[scenarioId].map((name): AttendedCheck => ({
      name,
      status: 'passed',
      detail: 'recorded by the script',
    })),
    artifacts: [{ name: 'export.mp4', path: 'exports/export.mp4', sha256: DIGEST, bytes: 72263 }],
  };
}

function mutated(scenarioId: AttendedScenarioId, change: (receipt: Mutable) => void): unknown {
  const receipt = JSON.parse(JSON.stringify(validReceipt(scenarioId))) as Mutable;
  change(receipt);
  return receipt;
}

function expectation(scenarioId: AttendedScenarioId) {
  return { scenarioId, candidateSha: CANDIDATE };
}

describe('attended receipt contract', () => {
  it('lists four scenarios, each with at least one required check', () => {
    expect(ATTENDED_SCENARIOS).toHaveLength(4);
    for (const id of ATTENDED_SCENARIOS) {
      expect(REQUIRED_ATTENDED_CHECKS[id].length).toBeGreaterThan(0);
    }
  });

  it.each(ATTENDED_SCENARIOS)('accepts a complete scripted receipt for %s', (id) => {
    expect(validateAttendedReceipt(validReceipt(id), expectation(id))).toEqual([]);
  });

  it('refuses a manual run, which is never a receipt', () => {
    const id = 'desktop.app.restart-save-export';
    const value = mutated(id, (receipt) => {
      (receipt.run as Mutable).mode = 'manual';
      (receipt.run as Mutable).manual = true;
    });
    const blockers = validateAttendedReceipt(value, expectation(id));
    expect(blockers).toContain('run.mode must be scripted; manual runs are not receipts');
    expect(blockers).toContain('run.manual must be false');
  });

  it('refuses a scenario that needed a retry or did not pass on the first attempt', () => {
    const id = 'project.persistence.fresh-process';
    const value = mutated(id, (receipt) => {
      (receipt.scenario as Mutable).retries = 1;
      (receipt.scenario as Mutable).firstAttemptPassed = false;
    });
    const blockers = validateAttendedReceipt(value, expectation(id));
    expect(blockers).toContain('scenario must pass on its first attempt');
    expect(blockers).toContain('scenario retries must be 0');
  });

  it('refuses a receipt for another candidate or with a malformed candidate SHA', () => {
    const id = 'desktop.export-media-semantics';
    const other = mutated(id, (receipt) => {
      receipt.candidateSha = '1c8d4f2a9b3e7c60d5f1a8e2b9c4d7f0a3e6b5c1';
    });
    expect(validateAttendedReceipt(other, expectation(id))).toContain(
      'candidateSha does not match the candidate under test',
    );
    const malformed = mutated(id, (receipt) => {
      receipt.candidateSha = 'DED976C8';
    });
    expect(validateAttendedReceipt(malformed, expectation(id))).toContain(
      'candidateSha must be a full lowercase commit SHA',
    );
  });

  it('refuses a receipt when the joy:// key differs before or after the run', () => {
    const id = 'cli.render.windows-entrypoints';
    const value = mutated(id, (receipt) => {
      (receipt.guards as Mutable).joyKeyAfter = 'b'.repeat(64);
    });
    expect(validateAttendedReceipt(value, expectation(id))).toContain(
      'joy:// key was not the expected value after the run',
    );
  });

  it('refuses a receipt when the owner asset library changed during the run', () => {
    const id = 'desktop.app.restart-save-export';
    const value = mutated(id, (receipt) => {
      (receipt.guards as Mutable).ownerLibraryFilesAfter = 3222;
    });
    expect(validateAttendedReceipt(value, expectation(id))).toContain(
      'the owner asset library changed during the run',
    );
  });

  it('refuses a receipt when the installed folder was touched', () => {
    const id = 'desktop.app.restart-save-export';
    const value = mutated(id, (receipt) => {
      (receipt.guards as Mutable).installedFolderTouched = true;
    });
    expect(validateAttendedReceipt(value, expectation(id))).toContain(
      'the installed JOY Media folder was touched',
    );
  });

  it('refuses a receipt that is missing a required check', () => {
    const id = 'desktop.export-media-semantics';
    const value = mutated(id, (receipt) => {
      receipt.checks = (receipt.checks as Mutable[]).filter((c) => c.name !== 'dissolve-checked');
    });
    expect(validateAttendedReceipt(value, expectation(id))).toContain(
      'required check dissolve-checked is missing',
    );
  });

  it('refuses a receipt with a failed, not-run or duplicated check', () => {
    const id = 'desktop.app.restart-save-export';
    const failed = mutated(id, (receipt) => {
      (receipt.checks as Mutable[])[0].status = 'failed';
    });
    expect(validateAttendedReceipt(failed, expectation(id))).toContain(
      'check project-saved is failed',
    );
    const duplicated = mutated(id, (receipt) => {
      receipt.checks = [...(receipt.checks as Mutable[]), (receipt.checks as Mutable[])[0]];
    });
    expect(validateAttendedReceipt(duplicated, expectation(id))).toContain(
      'required check project-saved is reported more than once',
    );
  });

  it('refuses artifacts with a bad digest, no size, or no artifacts at all', () => {
    const id = 'cli.render.windows-entrypoints';
    const badDigest = mutated(id, (receipt) => {
      (receipt.artifacts as Mutable[])[0].sha256 = 'not-a-digest';
    });
    expect(validateAttendedReceipt(badDigest, expectation(id))).toContain(
      'artifact export.mp4 must have a SHA-256 digest',
    );
    const emptyBytes = mutated(id, (receipt) => {
      (receipt.artifacts as Mutable[])[0].bytes = 0;
    });
    expect(validateAttendedReceipt(emptyBytes, expectation(id))).toContain(
      'artifact export.mp4 must have a positive byte count',
    );
    const none = mutated(id, (receipt) => {
      receipt.artifacts = [];
    });
    expect(validateAttendedReceipt(none, expectation(id))).toContain('artifacts are missing');
  });

  it('refuses a wrong schema, a wrong scenario, and a value that is not an object', () => {
    const id = 'project.persistence.fresh-process';
    const schema = mutated(id, (receipt) => {
      receipt.schema = 'joy-media.attended-receipt/0';
    });
    expect(validateAttendedReceipt(schema, expectation(id))).toContain(
      `schema must be ${ATTENDED_RECEIPT_SCHEMA}`,
    );
    const scenario = mutated(id, (receipt) => {
      (receipt.scenario as Mutable).id = 'desktop.export-media-semantics';
    });
    expect(validateAttendedReceipt(scenario, expectation(id))).toContain(
      `scenario id must be ${id}`,
    );
    expect(validateAttendedReceipt('not a receipt', expectation(id))).toEqual([
      'receipt is not a JSON object',
    ]);
  });

  it('assertAttendedReceipt throws with every blocker listed', () => {
    const id = 'desktop.app.restart-save-export';
    const value = mutated(id, (receipt) => {
      (receipt.run as Mutable).mode = 'manual';
      (receipt.scenario as Mutable).retries = 2;
    });
    expect(() => assertAttendedReceipt(value, expectation(id))).toThrow(
      'attended receipt refused:',
    );
    expect(() => assertAttendedReceipt(value, expectation(id))).toThrow(
      'manual runs are not receipts',
    );
    expect(() => assertAttendedReceipt(value, expectation(id))).toThrow(
      'scenario retries must be 0',
    );
    expect(() => assertAttendedReceipt(validReceipt(id), expectation(id))).not.toThrow();
  });
});
