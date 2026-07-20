import type { VerificationResult } from './verification.js';
import type { AggregateDiff } from './dry-run.js';

export interface AgentBranch {
  readonly branchId: string;
  readonly planId: string;
  readonly baseSnapshot: unknown;
  readonly branchSnapshot: unknown;
  readonly createdAt: string;
  readonly status: 'active' | 'accepted' | 'rejected' | 'expired';
  readonly verificationResult?: VerificationResult;
}

export interface BranchComparison {
  readonly diff: AggregateDiff;
  readonly summary: string;
}

export class BranchManager {
  private branches = new Map<string, AgentBranch>();
  private branchCounter = 0;

  createBranch(planId: string, baseSnapshot: unknown, branchSnapshot: unknown): AgentBranch {
    const branchId = `branch-${++this.branchCounter}-${Date.now()}`;
    const branch: AgentBranch = {
      branchId,
      planId,
      baseSnapshot,
      branchSnapshot,
      createdAt: new Date().toISOString(),
      status: 'active',
    };
    this.branches.set(branchId, branch);
    return branch;
  }

  getBranch(branchId: string): AgentBranch | undefined {
    return this.branches.get(branchId);
  }

  acceptBranch(branchId: string): { success: boolean; error?: string } {
    const branch = this.branches.get(branchId);
    if (!branch) {
      return { success: false, error: `Branch ${branchId} not found` };
    }
    if (branch.status !== 'active') {
      return {
        success: false,
        error: `Branch ${branchId} is not active (status: ${branch.status})`,
      };
    }
    this.branches.set(branchId, { ...branch, status: 'accepted' });
    return { success: true };
  }

  rejectBranch(branchId: string): { success: boolean; error?: string } {
    const branch = this.branches.get(branchId);
    if (!branch) {
      return { success: false, error: `Branch ${branchId} not found` };
    }
    if (branch.status !== 'active') {
      return {
        success: false,
        error: `Branch ${branchId} is not active (status: ${branch.status})`,
      };
    }
    this.branches.set(branchId, { ...branch, status: 'rejected' });
    return { success: true };
  }

  compareBranch(branchId: string): BranchComparison | undefined {
    const branch = this.branches.get(branchId);
    if (!branch) {
      return undefined;
    }

    const base = branch.baseSnapshot as Record<string, unknown> | null;
    const branchState = branch.branchSnapshot as Record<string, unknown> | null;

    if (!base || !branchState) {
      return {
        diff: {
          clipsCreated: 0,
          clipsModified: 0,
          clipsDeleted: 0,
          tracksAffected: [],
          timeRangesAffected: [],
          effectsAdded: 0,
          captionsAdded: 0,
          jobsRequired: 0,
          summary: 'Cannot compare: missing snapshots',
        },
        summary: 'Cannot compare: missing snapshots',
      };
    }

    const baseClips = this.extractClipIds(base);
    const branchClips = this.extractClipIds(branchState);

    const created = [...branchClips].filter((id) => !baseClips.has(id));
    const deleted = [...baseClips].filter((id) => !branchClips.has(id));
    const modified = [...branchClips].filter((id) => baseClips.has(id));

    const diff: AggregateDiff = {
      clipsCreated: created.length,
      clipsModified: modified.length,
      clipsDeleted: deleted.length,
      tracksAffected: [],
      timeRangesAffected: [],
      effectsAdded: 0,
      captionsAdded: 0,
      jobsRequired: 0,
      summary: `${created.length} created, ${modified.length} modified, ${deleted.length} deleted`,
    };

    return {
      diff,
      summary: diff.summary,
    };
  }

  getActiveBranches(): readonly AgentBranch[] {
    return Array.from(this.branches.values()).filter((b) => b.status === 'active');
  }

  expireOlderThan(maxAgeMs: number): number {
    const now = Date.now();
    let expiredCount = 0;

    for (const [branchId, branch] of this.branches.entries()) {
      if (branch.status === 'active') {
        const createdAt = new Date(branch.createdAt).getTime();
        const age = now - createdAt;
        if (age > maxAgeMs) {
          this.branches.set(branchId, { ...branch, status: 'expired' });
          expiredCount++;
        }
      }
    }

    return expiredCount;
  }

  private extractClipIds(state: Record<string, unknown>): Set<string> {
    const clipIds = new Set<string>();
    const compositions = (state.compositions as Record<string, unknown>) ?? {};

    for (const comp of Object.values(compositions)) {
      const c = comp as { tracks?: Array<{ clips?: Array<{ id?: string }> }> };
      for (const track of c.tracks ?? []) {
        for (const clip of track.clips ?? []) {
          if (clip.id) clipIds.add(clip.id);
        }
      }
    }

    return clipIds;
  }
}

export function createBranchManager(): BranchManager {
  return new BranchManager();
}
