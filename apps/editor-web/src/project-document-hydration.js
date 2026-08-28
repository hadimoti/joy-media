import { validateArtifactContentRef, validateArtifactProvenance, validateCreativeArtifact, validateJoyProjectV1, validateProjectDocumentV2, validateSpikeProject, validateWorkflowGraph, } from '@joy-media/project-schema';
/**
 * Validate and normalize an untrusted V2 transport document before it reaches
 * the mutable editor. No caller should cast a journal or remote response
 * directly into an EditorSession.
 */
export function planProjectDocumentHydration(value, expectedProjectId, options) {
    let diagnostics;
    try {
        diagnostics = validateProjectDocumentV2(value);
    }
    catch (error) {
        return {
            ok: false,
            warnings: [error instanceof Error ? error.message : 'invalid V2 document shape'],
        };
    }
    if (diagnostics.length > 0)
        return { ok: false, warnings: diagnostics.map((entry) => `${entry.path}: ${entry.message}`) };
    const document = value;
    if (document.projectId !== expectedProjectId) {
        return {
            ok: false,
            warnings: [`projectId does not match opened project "${expectedProjectId}"`],
        };
    }
    const visual = document.project;
    const timeline = document.timeline;
    if (!isRecord(visual) || !isRecord(timeline)) {
        return {
            ok: false,
            warnings: ['V2 document must contain object-valued project and timeline domains'],
        };
    }
    const sourceVisual = visual;
    const sourceTimeline = timeline;
    const sessionProjectId = options.sessionProjectId ?? expectedProjectId;
    // The legacy schema migrator may have already advanced the nested visual
    // project to schema v2. The editor lens still consumes its v1 projection;
    // the envelope remains the durable source and retains the extra fields.
    const visualForEditor = sourceVisual.schemaVersion === 2
        ? { ...sourceVisual, schemaVersion: 1 }
        : visual;
    const visualProject = {
        ...cloneJson(visualForEditor),
        id: sessionProjectId,
    };
    const timelineProject = {
        ...cloneJson(timeline),
        id: sessionProjectId,
    };
    const visualDiagnostics = safelyValidate(() => validateJoyProjectV1(visualProject));
    const timelineDiagnostics = safelyValidate(() => validateSpikeProject(timelineProject));
    if (visualDiagnostics.length > 0 || timelineDiagnostics.length > 0) {
        return {
            ok: false,
            warnings: [
                ...visualDiagnostics.map((entry) => `project.${entry.path}: ${entry.message}`),
                ...timelineDiagnostics.map((entry) => `timeline.${entry.path}: ${entry.message}`),
            ],
        };
    }
    const sourceVisualId = sourceVisual.id;
    const sourceTimelineId = sourceTimeline.id;
    if ((sourceVisualId !== expectedProjectId && sourceVisualId !== sessionProjectId) ||
        (sourceTimelineId !== expectedProjectId && sourceTimelineId !== sessionProjectId)) {
        return { ok: false, warnings: ['project and timeline ids do not match the opened project'] };
    }
    // The envelope title is the canonical title when present. Revalidate after
    // applying it because it is still untrusted transport data.
    const titledProject = document.title === undefined || document.title === visualProject.title
        ? visualProject
        : { ...visualProject, title: document.title };
    const titledDiagnostics = safelyValidate(() => validateJoyProjectV1(titledProject));
    if (titledDiagnostics.length > 0)
        return {
            ok: false,
            warnings: titledDiagnostics.map((entry) => `project.${entry.path}: ${entry.message}`),
        };
    const plan = {
        visualProject: titledProject,
        timelineProject,
        audioStatePresent: document.audio !== undefined,
    };
    let audioState;
    if (document.workflow !== undefined || document.artifacts !== undefined) {
        if (!options.graphEnabled)
            return {
                ok: false,
                warnings: ['V2 document contains Dual Lens data while graph editing is disabled'],
            };
        if (document.workflow !== undefined) {
            const graphDiagnostics = validateWorkflowGraph(document.workflow, 'workflow');
            if (graphDiagnostics.length > 0)
                return {
                    ok: false,
                    warnings: graphDiagnostics.map((entry) => `${entry.path}: ${entry.message}`),
                };
            plan.workflowGraph = cloneJson(document.workflow);
        }
        if (document.artifacts !== undefined) {
            const artifacts = validateArtifacts(document.artifacts);
            if (!artifacts.ok)
                return artifacts;
            plan.artifacts = artifacts.store;
        }
    }
    if (document.audio !== undefined) {
        const audio = validateAudioState(document.audio);
        if (!audio.ok)
            return audio;
        audioState = audio.audio;
    }
    return {
        ok: true,
        plan: {
            ...plan,
            ...(audioState === undefined
                ? {
                    // Omission is authoritative: do not carry an embedded/stale audio
                    // graph into a newly hydrated session.
                    visualProject: withoutAudio(titledProject),
                }
                : {
                    audioState,
                    // ProjectAudioV1 is the JSON projection of the richer AudioState;
                    // keep the sidecar and the visual document in lockstep.
                    visualProject: {
                        ...titledProject,
                        audio: cloneJson(document.audio),
                    },
                }),
        },
    };
}
function validateArtifacts(value) {
    if (!isRecord(value) || !isRecord(value.artifacts) || !isRecord(value.versions))
        return { ok: false, warnings: ['artifacts must contain artifacts and versions records'] };
    const warnings = [];
    for (const [id, artifact] of Object.entries(value.artifacts)) {
        const diagnostics = validateCreativeArtifact(artifact, `artifacts.${id}`);
        if (diagnostics.length > 0)
            warnings.push(...diagnostics.map((entry) => `${entry.path}: ${entry.message}`));
        if (!isRecord(artifact) || artifact.id !== id)
            warnings.push(`artifacts.${id}.id must match its key`);
    }
    const versions = {};
    for (const [id, list] of Object.entries(value.versions)) {
        if (!Array.isArray(list) || value.artifacts[id] === undefined) {
            warnings.push(`versions.${id} must be an array for an existing artifact`);
            continue;
        }
        const cloned = cloneJson(list);
        for (const [index, version] of cloned.entries()) {
            if (!isRecord(version) ||
                version.artifactId !== id ||
                typeof version.id !== 'string' ||
                typeof version.revision !== 'number' ||
                !Number.isSafeInteger(version.revision) ||
                version.revision < 0 ||
                !isRecord(version.contentRef) ||
                !isRecord(version.provenance) ||
                typeof version.createdAt !== 'string') {
                warnings.push(`versions.${id}[${String(index)}] is invalid`);
                continue;
            }
            warnings.push(...validateArtifactContentRef(version.contentRef, `versions.${id}[${String(index)}].contentRef`).map((entry) => `${entry.path}: ${entry.message}`));
            warnings.push(...validateArtifactProvenance(version.provenance, `versions.${id}[${String(index)}].provenance`).map((entry) => `${entry.path}: ${entry.message}`));
        }
        versions[id] = cloned;
    }
    if (warnings.length > 0)
        return { ok: false, warnings };
    return {
        ok: true,
        store: {
            artifacts: cloneJson(value.artifacts),
            versions,
        },
    };
}
function validateAudioState(value) {
    if (!isRecord(value) ||
        !isRecord(value.clips) ||
        !Array.isArray(value.buses) ||
        !Array.isArray(value.effects))
        return { ok: false, warnings: ['audio sidecar must contain clips, buses, and effects'] };
    const warnings = [];
    for (const [id, clip] of Object.entries(value.clips)) {
        if (!isRecord(clip) ||
            !finite(clip.gain) ||
            !finite(clip.pan) ||
            typeof clip.mute !== 'boolean' ||
            typeof clip.solo !== 'boolean' ||
            (clip.fadeInUs !== undefined && !finite(clip.fadeInUs)) ||
            (clip.fadeOutUs !== undefined && !finite(clip.fadeOutUs)))
            warnings.push(`audio.clips.${id} is invalid`);
    }
    for (const [index, bus] of value.buses.entries()) {
        if (!isRecord(bus) ||
            typeof bus.id !== 'string' ||
            typeof bus.name !== 'string' ||
            !finite(bus.gain) ||
            !finite(bus.pan) ||
            typeof bus.mute !== 'boolean' ||
            typeof bus.solo !== 'boolean' ||
            !Array.isArray(bus.inputs) ||
            !bus.inputs.every((entry) => typeof entry === 'string'))
            warnings.push(`audio.buses.${String(index)} is invalid`);
    }
    for (const [index, effect] of value.effects.entries()) {
        if (!isRecord(effect) ||
            typeof effect.id !== 'string' ||
            typeof effect.targetId !== 'string' ||
            !isAudioEffect(effect.effect))
            warnings.push(`audio.effects.${String(index)} is invalid`);
    }
    return warnings.length > 0
        ? { ok: false, warnings }
        : { ok: true, audio: cloneJson(value) };
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function withoutAudio(project) {
    const without = { ...project };
    delete without.audio;
    return without;
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isAudioEffect(value) {
    if (!isRecord(value) || typeof value.kind !== 'string')
        return false;
    if (value.kind === 'eq') {
        return (Array.isArray(value.bands) &&
            value.bands.every((band) => isRecord(band) &&
                finite(band.frequency) &&
                finite(band.gain) &&
                finite(band.q) &&
                typeof band.type === 'string' &&
                ['lowpass', 'highpass', 'bandpass', 'peaking', 'lowshelf', 'highshelf'].includes(band.type)));
    }
    const required = value.kind === 'compressor'
        ? ['threshold', 'ratio', 'attackUs', 'releaseUs', 'knee']
        : value.kind === 'limiter'
            ? ['ceiling', 'releaseUs']
            : value.kind === 'gate'
                ? ['threshold', 'attackUs', 'releaseUs', 'holdUs']
                : [];
    return required.length > 0 && required.every((key) => finite(value[key]));
}
function safelyValidate(validate) {
    try {
        return validate();
    }
    catch (error) {
        return [
            { path: '', message: error instanceof Error ? error.message : 'invalid document shape' },
        ];
    }
}
function cloneJson(value) {
    if (Array.isArray(value))
        return value.map(cloneJson);
    if (isRecord(value))
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
    return value;
}
//# sourceMappingURL=project-document-hydration.js.map