import type { BenchmarkIntent, BenchmarkProject } from './types.js';
import type { EditorContext } from '../context.js';

export const BENCHMARK_INTENTS: readonly BenchmarkIntent[] = [
  {
    id: 'bench-001',
    name: 'Insert single clip',
    description: 'Insert a video clip at the playhead',
    intent: 'Add a new video clip at the current playhead position',
    expectedPlanSteps: 1,
    expectedTools: ['insertClip'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [
      { name: 'clip-created', type: 'entities-created', params: { entityType: 'clip', count: 1 } },
      { name: 'no-overlaps', type: 'no-overlaps' },
    ],
  },
  {
    id: 'bench-002',
    name: 'Trim clip',
    description: 'Trim a clip start and end',
    intent: 'Trim the selected clip from 2s to 8s',
    expectedPlanSteps: 1,
    expectedTools: ['trimClip'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [
      {
        name: 'clip-modified',
        type: 'entities-modified',
        params: { entityType: 'clip', count: 1 },
      },
    ],
  },
  {
    id: 'bench-003',
    name: 'Multiple clip operations',
    description: 'Insert and trim multiple clips',
    intent: 'Add two video clips and trim the first one',
    expectedPlanSteps: 3,
    expectedTools: ['insertClip', 'insertClip', 'trimClip'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [
      { name: 'clips-created', type: 'entities-created', params: { entityType: 'clip', count: 2 } },
      {
        name: 'clip-modified',
        type: 'entities-modified',
        params: { entityType: 'clip', count: 1 },
      },
      { name: 'no-overlaps', type: 'no-overlaps' },
    ],
  },
  {
    id: 'bench-004',
    name: 'Audio gain adjustment',
    description: 'Adjust audio clip gain',
    intent: 'Set the audio gain to -3dB for the selected clip',
    expectedPlanSteps: 1,
    expectedTools: ['setGain'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [
      {
        name: 'clip-modified',
        type: 'entities-modified',
        params: { entityType: 'clip', count: 1 },
      },
      { name: 'audio-valid', type: 'audio-valid' },
    ],
  },
  {
    id: 'bench-005',
    name: 'Caption search and edit',
    description: 'Search and modify captions',
    intent: 'Find all captions with low confidence and adjust their timing',
    expectedPlanSteps: 2,
    expectedTools: ['searchTranscript', 'trimClip'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [{ name: 'captions-valid', type: 'captions-valid' }],
  },
  {
    id: 'bench-006',
    name: 'Effect application',
    description: 'Add audio effect to clip',
    intent: 'Add a noise reduction effect to the audio clip',
    expectedPlanSteps: 1,
    expectedTools: ['addEffect'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [
      {
        name: 'effect-created',
        type: 'entities-created',
        params: { entityType: 'effect', count: 1 },
      },
    ],
  },
  {
    id: 'bench-007',
    name: 'Complex multi-step edit',
    description: 'Complex editing workflow',
    intent: 'Insert a clip, split it, add an effect, and adjust gain',
    expectedPlanSteps: 4,
    expectedTools: ['insertClip', 'splitClip', 'addEffect', 'setGain'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [
      { name: 'clips-created', type: 'entities-created', params: { entityType: 'clip', count: 2 } },
      {
        name: 'effect-created',
        type: 'entities-created',
        params: { entityType: 'effect', count: 1 },
      },
      { name: 'no-overlaps', type: 'no-overlaps' },
    ],
  },
  {
    id: 'bench-008',
    name: 'Local-only constraint test',
    description: 'Verify local-only operations stay local',
    intent: 'Perform basic editing operations that should remain local',
    expectedPlanSteps: 2,
    expectedTools: ['insertClip', 'moveClip'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [{ name: 'local-only-respected', type: 'local-only-respected' }],
  },
  {
    id: 'bench-009',
    name: 'Approval-required operation',
    description: 'Operation that requires approval',
    intent: 'Export the project to a remote service',
    expectedPlanSteps: 1,
    expectedTools: ['exportProject'],
    requiresApproval: ['remote-upload'],
    localOnly: false,
    validationChecks: [{ name: 'approval-requested', type: 'approval-requested' }],
  },
  {
    id: 'bench-010',
    name: 'Revert scenario',
    description: 'Test revert capability',
    intent: 'Make changes and then revert them',
    expectedPlanSteps: 2,
    expectedTools: ['insertClip', 'removeClip'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [{ name: 'revert-possible', type: 'revert-possible' }],
  },
  {
    id: 'bench-011',
    name: 'Cost estimation accuracy',
    description: 'Verify cost estimation accuracy',
    intent: 'Perform operations with known costs',
    expectedPlanSteps: 2,
    expectedTools: ['setGain', 'setPan'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [
      { name: 'cost-within-limit', type: 'cost-within-limit', params: { maxCost: '0.00' } },
    ],
  },
  {
    id: 'bench-012',
    name: 'Split and join clips',
    description: 'Split a clip and join it back',
    intent: 'Split the selected clip at the playhead and join the pieces',
    expectedPlanSteps: 2,
    expectedTools: ['splitClip', 'joinClips'],
    requiresApproval: [],
    localOnly: true,
    validationChecks: [
      { name: 'clips-created', type: 'entities-created', params: { entityType: 'clip', count: 1 } },
      { name: 'no-overlaps', type: 'no-overlaps' },
    ],
  },
];

function createTestContext(overrides?: Partial<EditorContext>): EditorContext {
  return {
    project: {
      id: 'bench-project',
      name: 'Benchmark Project',
      durationUs: 60_000_000,
      compositionCount: 1,
      trackCount: 2,
      clipCount: 2,
      hasCaptions: false,
      hasAudio: true,
      missingAssets: [],
    },
    selection: {
      selectedClipIds: ['clip-1'],
      selectedTrackIds: ['track-1'],
      playheadUs: 5_000_000,
    },
    timeline: {
      compositions: [
        {
          id: 'comp-1',
          name: 'Main',
          width: 1920,
          height: 1080,
          frameRate: { num: 30, den: 1 },
          durationUs: 60_000_000,
          trackCount: 2,
        },
      ],
      totalDurationUs: 60_000_000,
    },
    captions: {
      documentCount: 1,
      languages: ['en'],
      totalWordCount: 100,
      lowConfidenceSegments: 2,
    },
    audio: {
      clipCount: 2,
      busCount: 1,
      hasDialogue: true,
      peakLevelDb: -3.0,
      loudnessLufs: -16.0,
    },
    providers: {
      availableProviders: [],
      localOnly: true,
    },
    availableTools: [
      'insertClip',
      'removeClip',
      'moveClip',
      'trimClip',
      'splitClip',
      'joinClips',
      'setGain',
      'setPan',
      'setMute',
      'setFade',
      'addEffect',
      'searchTranscript',
    ],
    recentHistory: [],
    constraints: [],
    ...overrides,
  };
}

function createTestProjectState(): unknown {
  return {
    schemaVersion: 0,
    id: 'bench-project',
    title: 'Benchmark Project',
    rootCompositionId: 'comp-1',
    compositions: {
      'comp-1': {
        id: 'comp-1',
        name: 'Main',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: 60_000_000,
        tracks: [
          {
            kind: 'video',
            clips: [
              {
                id: 'clip-1',
                kind: 'video',
                startUs: 0,
                durationUs: 10_000_000,
                assetId: 'asset-1',
              },
              {
                id: 'clip-2',
                kind: 'video',
                startUs: 10_000_000,
                durationUs: 5_000_000,
                assetId: 'asset-2',
              },
            ],
          },
          {
            kind: 'audio',
            clips: [
              {
                id: 'audio-1',
                kind: 'audio',
                startUs: 0,
                durationUs: 15_000_000,
                assetId: 'asset-3',
              },
            ],
          },
        ],
      },
    },
    assets: {
      'asset-1': { id: 'asset-1', path: '/path/to/asset1.mp4' },
      'asset-2': { id: 'asset-2', path: '/path/to/asset2.mp4' },
      'asset-3': { id: 'asset-3', path: '/path/to/asset3.wav' },
    },
    captionDocuments: {
      'caption-1': {
        id: 'caption-1',
        language: 'en',
        words: {
          w1: { text: 'Hello', confidence: 0.95 },
          w2: { text: 'world', confidence: 0.65 },
        },
        segments: [{ startUs: 0, endUs: 2_000_000, wordIds: ['w1', 'w2'] }],
      },
    },
    audio: {
      peakLevelDb: -3.0,
      loudnessLufs: -16.0,
    },
  };
}

export const BENCHMARK_PROJECTS: readonly BenchmarkProject[] = [
  {
    id: 'bench-project-1',
    name: 'Standard Benchmark Project',
    description: 'A standard project with video, audio, and captions',
    projectState: createTestProjectState(),
    context: createTestContext(),
  },
  {
    id: 'bench-project-2',
    name: 'Minimal Project',
    description: 'A minimal project with only video',
    projectState: {
      schemaVersion: 0,
      id: 'minimal-project',
      title: 'Minimal Project',
      rootCompositionId: 'comp-1',
      compositions: {
        'comp-1': {
          id: 'comp-1',
          name: 'Main',
          durationUs: 30_000_000,
          tracks: [
            {
              kind: 'video',
              clips: [
                {
                  id: 'clip-1',
                  kind: 'video',
                  startUs: 0,
                  durationUs: 10_000_000,
                  assetId: 'asset-1',
                },
              ],
            },
          ],
        },
      },
      assets: {
        'asset-1': { id: 'asset-1', path: '/path/to/asset1.mp4' },
      },
    },
    context: createTestContext({
      project: {
        id: 'minimal-project',
        name: 'Minimal Project',
        durationUs: 30_000_000,
        compositionCount: 1,
        trackCount: 1,
        clipCount: 1,
        hasCaptions: false,
        hasAudio: false,
        missingAssets: [],
      },
      captions: undefined,
    }),
  },
];
