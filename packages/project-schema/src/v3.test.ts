import { describe, expect, it } from 'vitest';
import type { SpikeProject } from './model.js';
import { rational } from './time.js';
import { migrateV0ToV1, migrateV1ToV2, migrateV2ToV3, migrateToLatest } from './migration.js';
import { validateJoyProjectV2 } from './v2.js';
import {
  LATEST_PROJECT_SCHEMA_VERSION,
  isJoyProjectV3,
  validateJoyProjectV3,
  type JoyProjectV3,
} from './v3.js';
import type { LookInstance } from './living-look.js';

const SPIKE: SpikeProject = {
  schemaVersion: 0,
  id: 'schema-v3-fixture',
  rootCompositionId: 'comp-root',
  compositions: {
    'comp-root': {
      id: 'comp-root',
      name: 'Reel',
      width: 1080,
      height: 1920,
      frameRate: rational(30, 1),
      durationUs: 30_000_000,
      tracks: [{ id: 'v1', kind: 'video', order: 0, enabled: true, clips: [] }],
    },
  },
};

function v2() {
  return migrateV1ToV2(migrateV0ToV1(SPIKE).project).project;
}

const LOOK: LookInstance = {
  id: 'look-1',
  definitionId: 'editorial-clean',
  definitionVersion: 2,
  compositionId: 'comp-root',
  entityBindings: { headline: 'title-1' },
  controlValues: { energy: 0.4 },
  overriddenBindingIds: [],
  createdEntityIds: ['title-1'],
};

describe('schema v3 — Living Look instances', () => {
  describe('v2 -> v3 migration', () => {
    it('a v2 project with no Looks round-trips unchanged apart from the version', () => {
      const before = v2();
      const { project, report } = migrateV2ToV3(before);

      expect(project.schemaVersion).toBe(3);
      expect(report).toEqual({ fromVersion: 2, toVersion: 3, defaultsApplied: [] });
      // No lookInstances key is added — "never applied" stays distinct from
      // "all detached".
      expect('lookInstances' in project).toBe(false);
      const { schemaVersion: _b, ...beforeRest } = before;
      const { schemaVersion: _a, ...afterRest } = project;
      expect(afterRest).toEqual(beforeRest);
    });

    it('is reachable and idempotent through migrateToLatest from every prior schema version', () => {
      for (const start of [migrateV0ToV1(SPIKE).project, v2()]) {
        const once = migrateToLatest(start);
        const twice = migrateToLatest(once);
        expect(once.schemaVersion).toBe(LATEST_PROJECT_SCHEMA_VERSION);
        expect(isJoyProjectV3(once)).toBe(true);
        expect(twice).toEqual(once);
      }
    });

    it('the migrated v3 document still passes the v2 body validator', () => {
      const project = migrateV2ToV3(v2()).project;
      expect(validateJoyProjectV2({ ...project, schemaVersion: 2 })).toEqual([]);
    });
  });

  describe('validateJoyProjectV3', () => {
    it('accepts a v3 document carrying a well-formed Look instance', () => {
      const project: JoyProjectV3 = {
        ...migrateV2ToV3(v2()).project,
        lookInstances: { 'look-1': LOOK },
      };
      expect(validateJoyProjectV3(project)).toEqual([]);
    });

    it('preserves a pinned definitionVersion through JSON round-trip', () => {
      const project: JoyProjectV3 = {
        ...migrateV2ToV3(v2()).project,
        lookInstances: { 'look-1': LOOK },
      };
      const restored = JSON.parse(JSON.stringify(project)) as JoyProjectV3;
      expect(restored.lookInstances!['look-1']!.definitionVersion).toBe(2);
      expect(validateJoyProjectV3(restored)).toEqual([]);
    });

    it('flags schemaVersion that is not 3 without discarding the body', () => {
      const project = { ...migrateV2ToV3(v2()).project, schemaVersion: 4 };
      const result = validateJoyProjectV3(project);
      expect(result.map((d) => d.code)).toContain('PROJECT_SCHEMA_V3_VERSION');
    });

    it('rejects a malicious Look instance (executable payload in a control value)', () => {
      const project = {
        ...migrateV2ToV3(v2()).project,
        lookInstances: {
          'look-1': { ...LOOK, controlValues: { label: 'javascript:steal()' } },
        },
      };
      expect(validateJoyProjectV3(project).map((d) => d.code)).toContain(
        'PROJECT_SCHEMA_LOOK_INSTANCE_FORBIDDEN_VALUE',
      );
    });

    it('rejects a lookInstances key that collides with a different id', () => {
      const project = {
        ...migrateV2ToV3(v2()).project,
        lookInstances: { 'wrong-key': LOOK },
      };
      expect(validateJoyProjectV3(project).map((d) => d.code)).toContain(
        'PROJECT_SCHEMA_LOOK_INSTANCE_KEY',
      );
    });

    it('rejects a non-object', () => {
      expect(validateJoyProjectV3(null).map((d) => d.code)).toEqual([
        'PROJECT_SCHEMA_V3_NOT_OBJECT',
      ]);
    });
  });
});
