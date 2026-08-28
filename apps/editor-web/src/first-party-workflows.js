// apps/editor-web/src/first-party-workflows.ts
import { buildFirstPartyPipelinePacks, buildFirstPartyWorkflows, firstPartyDefinitionFiles, FIRST_PARTY_WORKFLOWS_VERSION, FIRST_PARTY_WORKFLOW_IDS, } from '@joy-media/workflow-engine';
let cachedWorkflows;
export function loadFirstPartyWorkflows() {
    if (cachedWorkflows !== undefined)
        return cachedWorkflows;
    const packs = buildFirstPartyPipelinePacks();
    const builtWorkflows = buildFirstPartyWorkflows();
    const definitionFiles = firstPartyDefinitionFiles();
    const packsById = new Map(packs.map((pack) => [pack.workflow.id, pack]));
    const definitionFilesById = new Map(definitionFiles.map((file) => {
        const parsed = JSON.parse(file.json);
        return [typeof parsed.id === 'string' ? parsed.id : file.fileName, file];
    }));
    cachedWorkflows = builtWorkflows.map((built) => {
        const pack = packsById.get(built.workflow.id);
        const definitionFile = definitionFilesById.get(built.workflow.id);
        return {
            workflow: built.workflow,
            fileName: definitionFile?.fileName ?? `${built.workflow.id}.json`,
            label: pack?.label ?? 'Unavailable system workflow',
            summary: pack?.summary ?? built.workflow.name,
            requiredPorts: pack?.requiredPorts ?? [],
            optionalPorts: pack?.optionalPorts ?? [],
            capabilities: pack?.capabilities ?? built.workflow.permissions.map((p) => p.capability),
            approvals: pack?.approvals ?? [],
            reportRefs: pack?.reportRefs ?? [],
        };
    });
    return cachedWorkflows;
}
export function getFirstPartyWorkflow(workflowId) {
    return loadFirstPartyWorkflows().find((entry) => entry.workflow.id === workflowId);
}
export function getFirstPartyWorkflowVersion() {
    return FIRST_PARTY_WORKFLOWS_VERSION;
}
/**
 * WP-17.3 — surface lineage when a recorded workflow's goal/name references a
 * first-party system workflow. Exact recording-from-system lineage lands later;
 * this makes teachable reuse visible without inventing false provenance.
 */
export function detectDerivedFrom(recorded) {
    const haystack = `${recorded.workflow.name} ${recorded.originalPlan.goal}`.toLowerCase();
    for (const id of FIRST_PARTY_WORKFLOW_IDS) {
        const short = id.replace('joy.first-party.', '').replaceAll('-', ' ');
        if (haystack.includes(id.toLowerCase()) || haystack.includes(short)) {
            return id;
        }
    }
    const firstStep = recorded.originalPlan.steps[0];
    if (firstStep !== undefined) {
        const stepHaystack = `${firstStep.tool} ${firstStep.description}`.toLowerCase();
        for (const id of FIRST_PARTY_WORKFLOW_IDS) {
            const short = id.replace('joy.first-party.', '').replaceAll('-', ' ');
            if (stepHaystack.includes(short)) {
                return id;
            }
        }
    }
    return undefined;
}
export { FIRST_PARTY_WORKFLOW_IDS };
//# sourceMappingURL=first-party-workflows.js.map