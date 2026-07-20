/** Private/team template catalog and quality contract (§25.2–§25.7). */

export type TemplateVariableValue = string | number | boolean;
export type TemplateSlotMedia = 'image' | 'video' | 'audio';
export type TemplateFitPolicy = 'cover' | 'contain' | 'stretch' | 'author-defined';
export type TemplateDurationRule =
  'fixed' | 'stretch-keyframes' | 'loop-region' | 'repeat-items' | 'reflow' | 'named-variant';
export type TemplateCatalogScope = 'first-party-private' | 'team-private';

export interface TeamTemplateVariable {
  readonly type: 'string' | 'number' | 'boolean' | 'color';
  readonly default: TemplateVariableValue;
  readonly required?: boolean;
}

export interface TeamTemplateSlot {
  readonly id: string;
  readonly label: string;
  readonly accepts: readonly TemplateSlotMedia[];
  readonly required: boolean;
  readonly fitPolicy: TemplateFitPolicy;
  readonly durationHintUs?: number;
}

export interface TeamTemplateV1 {
  readonly formatVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly scope: TemplateCatalogScope;
  readonly joyApi: string;
  readonly variables: Readonly<Record<string, TeamTemplateVariable>>;
  readonly slots: readonly TeamTemplateSlot[];
  readonly dependencies: {
    readonly plugins: readonly string[];
    readonly fonts: readonly string[];
    readonly providers: readonly string[];
  };
  readonly protectedRegions: readonly {
    readonly id: string;
    readonly startUs: number;
    readonly endUs: number;
  }[];
  readonly durationRule: TemplateDurationRule;
  readonly targetProfiles: readonly {
    readonly width: number;
    readonly height: number;
    readonly durationUs: number;
  }[];
  readonly license: { readonly commercialUse: boolean; readonly attribution?: string };
  readonly fallback: 'editable' | 'read-only';
}

export interface TemplateQualityIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/** Catalog accepts only private first-party/team packages; no public marketplace mode in P08. */
export class TeamTemplateCatalog {
  readonly #templates = new Map<string, TeamTemplateV1>();

  publish(template: TeamTemplateV1): readonly TemplateQualityIssue[] {
    const issues = validateTeamTemplate(template);
    if (issues.length === 0) this.#templates.set(template.id, template);
    return issues;
  }

  list(scope?: TemplateCatalogScope): readonly TeamTemplateV1[] {
    return [...this.#templates.values()].filter(
      (template) => scope === undefined || template.scope === scope,
    );
  }

  resolve(id: string): TeamTemplateV1 | undefined {
    return this.#templates.get(id);
  }
}

/** Ensures a template is safe/complete before it appears in a private catalog. */
export function validateTeamTemplate(value: unknown): readonly TemplateQualityIssue[] {
  const issues: TemplateQualityIssue[] = [];
  if (!isRecord(value))
    return [{ code: 'template/not-object', message: 'template must be an object', path: '$' }];
  if (value.formatVersion !== 1)
    issues.push(issue('template/version', 'formatVersion must be 1', 'formatVersion'));
  for (const key of ['id', 'name', 'version', 'joyApi'] as const)
    if (typeof value[key] !== 'string' || value[key].length === 0)
      issues.push(issue('template/field', `${key} must be non-empty`, key));
  if (value.scope !== 'first-party-private' && value.scope !== 'team-private')
    issues.push(issue('template/scope', 'scope must remain private in P08', 'scope'));
  if (!isRecord(value.variables))
    issues.push(issue('template/variables', 'variables must be an object', 'variables'));
  else
    for (const [key, variable] of Object.entries(value.variables)) {
      if (
        !isRecord(variable) ||
        !['string', 'number', 'boolean', 'color'].includes(String(variable.type)) ||
        !('default' in variable)
      )
        issues.push(
          issue(
            'template/variable',
            'variable needs supported type and default',
            `variables.${key}`,
          ),
        );
    }
  if (!Array.isArray(value.slots))
    issues.push(issue('template/slots', 'slots must be an array', 'slots'));
  else {
    const ids = new Set<string>();
    for (const [index, slot] of value.slots.entries()) {
      if (
        !isRecord(slot) ||
        typeof slot.id !== 'string' ||
        ids.has(slot.id) ||
        !Array.isArray(slot.accepts) ||
        slot.accepts.length === 0 ||
        !['cover', 'contain', 'stretch', 'author-defined'].includes(String(slot.fitPolicy))
      )
        issues.push(
          issue(
            'template/slot',
            'slot must have unique id, media accepts, and fit policy',
            `slots.${index}`,
          ),
        );
      else ids.add(slot.id);
    }
  }
  if (!isRecord(value.dependencies))
    issues.push(issue('template/dependencies', 'dependencies must be declared', 'dependencies'));
  if (!Array.isArray(value.protectedRegions))
    issues.push(
      issue('template/protected-regions', 'protected regions must be an array', 'protectedRegions'),
    );
  if (
    ![
      'fixed',
      'stretch-keyframes',
      'loop-region',
      'repeat-items',
      'reflow',
      'named-variant',
    ].includes(String(value.durationRule))
  )
    issues.push(issue('template/duration-rule', 'duration rule is invalid', 'durationRule'));
  if (!Array.isArray(value.targetProfiles) || value.targetProfiles.length === 0)
    issues.push(
      issue('template/profiles', 'at least one target profile is required', 'targetProfiles'),
    );
  if (!isRecord(value.license) || typeof value.license.commercialUse !== 'boolean')
    issues.push(issue('template/license', 'license/commercialUse is required', 'license'));
  if (value.fallback !== 'editable' && value.fallback !== 'read-only')
    issues.push(issue('template/fallback', 'fallback must be declared', 'fallback'));
  return issues;
}

function issue(code: string, message: string, path: string): TemplateQualityIssue {
  return { code, message, path };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
