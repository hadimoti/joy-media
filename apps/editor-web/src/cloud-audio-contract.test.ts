import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const cloudBlock = appSource.slice(
  appSource.indexOf('onRunRemoteMediaJob={async'),
  appSource.indexOf("if (api.id === 'effects')"),
);

describe('Cloud audio application contract', () => {
  it('recovers an already-submitted operation from the durable server ledger', () => {
    expect(appSource).toContain("operationLedger.recoverUncertain('cloud-audio')");
    expect(cloudBlock).toContain('existing === undefined');
    expect(cloudBlock).toContain("type: 'cloud-audio'");
    expect(cloudBlock).toContain('mediaControlPlaneClient.denoiseAudioOperation(');
    expect(cloudBlock).toContain('if (recovered === undefined)');
    expect(cloudBlock).toContain('projectId: controlPlaneProject.controlPlaneProjectId');
    expect(cloudBlock).toContain('operationId,');
    expect(cloudBlock).toContain('recovered.leaseExpiresAt > Date.now()');
    expect(cloudBlock).toContain(
      "recovered?.status === 'running' || recovered?.status === 'failed'",
    );
  });

  it('revalidates the project and exact target after persisting provider bytes', () => {
    const cachePut = cloudBlock.indexOf('await originalAssetCachePromise');
    const revisionCheck = cloudBlock.indexOf(
      'context.session.projectRevisionId !== sourceProjectRevisionId',
      cachePut,
    );
    const targetCheck = cloudBlock.indexOf(
      'currentTarget?.assetId !== targetAssetId',
      revisionCheck,
    );
    const currentProject = cloudBlock.indexOf(
      'const currentProject = context.session.visualProject',
      targetCheck,
    );
    const currentAudio = cloudBlock.indexOf('loadAudioStateFromProject(', currentProject);

    expect(cachePut).toBeGreaterThanOrEqual(0);
    expect(revisionCheck).toBeGreaterThan(cachePut);
    expect(targetCheck).toBeGreaterThan(revisionCheck);
    expect(currentProject).toBeGreaterThan(targetCheck);
    expect(currentAudio).toBeGreaterThan(currentProject);
  });

  it('uses each project rootCompositionId instead of a hard-coded root key', () => {
    expect(appSource).not.toContain('compositions.root');
  });
});
