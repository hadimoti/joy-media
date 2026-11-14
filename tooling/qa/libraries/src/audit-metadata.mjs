import os from 'node:os';
import path from 'node:path';

export const VALID_KINDS = ['filters', 'effects'];

/**
 * Parse CLI arguments for the library test harness.
 * Supported flags:
 *   --kind filters|effects   (default: 'filters')
 *   --items id1,id2          (optional comma-separated filter)
 *   --limit N                (optional positive integer cap)
 *   --out <dir>              (output folder for reports and screenshots)
 *   --face <path>            (optional face image file for the portrait quadrant)
 *   --help / -h              (prints usage)
 */
export function parseCliArgs(argv) {
  const args = [...argv];
  const parsed = {
    kind: 'filters',
    items: undefined,
    limit: undefined,
    outDir: undefined,
    facePath: undefined,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    const nextValue = () => {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${token}`);
      }
      i += 1;
      return value;
    };

    if (token === '--kind') {
      const value = nextValue().toLowerCase();
      if (!VALID_KINDS.includes(value)) {
        throw new Error(`Invalid --kind "${value}". Expected one of: ${VALID_KINDS.join(', ')}`);
      }
      parsed.kind = value;
    } else if (token.startsWith('--kind=')) {
      const value = token.slice('--kind='.length).toLowerCase();
      if (!VALID_KINDS.includes(value)) {
        throw new Error(`Invalid --kind "${value}". Expected one of: ${VALID_KINDS.join(', ')}`);
      }
      parsed.kind = value;
    } else if (token === '--items') {
      parsed.items = parseItemsCsv(nextValue());
    } else if (token.startsWith('--items=')) {
      parsed.items = parseItemsCsv(token.slice('--items='.length));
    } else if (token === '--limit') {
      parsed.limit = parsePositiveInt(nextValue(), '--limit');
    } else if (token.startsWith('--limit=')) {
      parsed.limit = parsePositiveInt(token.slice('--limit='.length), '--limit');
    } else if (token === '--out') {
      parsed.outDir = nextValue();
    } else if (token.startsWith('--out=')) {
      parsed.outDir = token.slice('--out='.length);
    } else if (token === '--face') {
      parsed.facePath = nextValue();
    } else if (token.startsWith('--face=')) {
      parsed.facePath = token.slice('--face='.length);
    } else {
      throw new Error(`Unknown CLI argument: ${token}`);
    }
  }

  return {
    ...parsed,
    outDir: parsed.outDir ?? path.join(os.tmpdir(), 'joy-media-library-tests', parsed.kind),
  };
}

function parseItemsCsv(raw) {
  const list = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (list.length === 0) {
    throw new Error('--items requires at least one non-empty effect id');
  }
  return list;
}

function parsePositiveInt(raw, flag) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== raw.trim()) {
    throw new Error(`Invalid ${flag} value "${raw}". Expected a positive integer.`);
  }
  return value;
}

function classifyKeyframesPolicy(note) {
  const cleaned = note.replaceAll('**', '').trim().toLowerCase();
  if (cleaned === 'no' || cleaned.startsWith('no ') || cleaned.startsWith('no(')) {
    return 'no';
  }
  if (cleaned.includes('amount only')) {
    return 'amount-only';
  }
  if (cleaned.startsWith('partly')) {
    return 'partly';
  }
  return 'yes';
}

function stripMarkdownFormatting(cell) {
  return cell.trim().replaceAll('**', '').replace(/^`|`$/g, '').trim();
}

/**
 * Parse Section 3 Table 1 of docs/qa/v1.1.1/LIBRARY-AUDIT.md into a lookup map
 * keyed by effect id.
 */
export function parseLibraryAuditMarkdown(markdown) {
  const map = new Map();
  const lines = markdown.split(/\r?\n/);
  let inSection3 = false;

  for (const line of lines) {
    if (/^##\s+3\./.test(line)) {
      inSection3 = true;
      continue;
    }
    if (inSection3 && /^##\s+4\./.test(line)) {
      break;
    }
    if (!inSection3 || !line.trim().startsWith('|')) continue;

    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 9) continue;

    const indexText = cells[0];
    if (!/^\d+$/.test(indexText)) continue;

    const id = stripMarkdownFormatting(cells[1]);
    const name = stripMarkdownFormatting(cells[2]);
    const home = cells[3].toLowerCase().includes('filter') ? 'filters' : 'effects';
    const category = stripMarkdownFormatting(cells[4]);
    const paramsSummary = cells[5];
    const cost = stripMarkdownFormatting(cells[6]);
    const exportRaw = stripMarkdownFormatting(cells[7]).toLowerCase();
    const exportFlag = exportRaw === 'yes' ? 'yes' : exportRaw === 'no' ? 'no' : 'unknown';
    const keyframesNote = cells[8];
    const keyframesPolicy = classifyKeyframesPolicy(keyframesNote);

    map.set(id, {
      index: Number.parseInt(indexText, 10),
      id,
      name,
      home,
      category,
      paramsSummary,
      cost,
      exportFlag,
      keyframesNote,
      keyframesPolicy,
    });
  }

  return map;
}

function snapToStep(value, min, max, step) {
  let clamped = Math.min(max, Math.max(min, value));
  if (typeof step === 'number' && Number.isFinite(step) && step > 0) {
    const steps = Math.round((clamped - min) / step);
    clamped = Math.min(max, Math.max(min, Number((min + steps * step).toFixed(6))));
  }
  return clamped;
}

/**
 * Plan low / default / high test values and a guaranteed non-default reset seed
 * for every parameter on an EffectDescriptor.
 */
export function planParameterVariations(descriptor) {
  return descriptor.params.map((param) => {
    if (param.type === 'number') {
      const min = typeof param.min === 'number' && Number.isFinite(param.min) ? param.min : 0;
      const max =
        typeof param.max === 'number' && Number.isFinite(param.max)
          ? param.max
          : Math.max(min + 1, typeof param.defaultValue === 'number' ? param.defaultValue : 1);
      const def =
        typeof param.defaultValue === 'number' && Number.isFinite(param.defaultValue)
          ? param.defaultValue
          : min;
      const low = snapToStep(min, min, max, param.step);
      const high = snapToStep(max, min, max, param.step);
      const resetSeed = Math.abs(high - def) >= Math.abs(low - def) ? high : low;
      return {
        key: param.key,
        label: param.label,
        type: param.type,
        defaultValue: def,
        resetSeed,
        cases: [
          { tag: 'low', value: low },
          { tag: 'default', value: def },
          { tag: 'high', value: high },
        ],
      };
    }

    if (param.type === 'boolean') {
      const def = Boolean(param.defaultValue);
      return {
        key: param.key,
        label: param.label,
        type: param.type,
        defaultValue: def,
        resetSeed: !def,
        cases: [
          { tag: 'low', value: false },
          { tag: 'default', value: def },
          { tag: 'high', value: true },
        ],
      };
    }

    if (param.type === 'enum') {
      const options = param.options ?? [];
      const first = options[0]?.value ?? param.defaultValue;
      const last = options[options.length - 1]?.value ?? param.defaultValue;
      const alt = options.find((opt) => opt.value !== param.defaultValue)?.value ?? first;
      return {
        key: param.key,
        label: param.label,
        type: param.type,
        defaultValue: param.defaultValue,
        resetSeed: alt,
        cases: [
          { tag: 'low', value: first },
          { tag: 'default', value: param.defaultValue },
          { tag: 'high', value: last },
        ],
      };
    }

    if (param.type === 'color') {
      const def = String(param.defaultValue);
      const low = '#000000';
      const high = '#ffffff';
      const resetSeed = def.toLowerCase() === '#ff3366' ? '#33ccff' : '#ff3366';
      return {
        key: param.key,
        label: param.label,
        type: param.type,
        defaultValue: def,
        resetSeed,
        cases: [
          { tag: 'low', value: low },
          { tag: 'default', value: def },
          { tag: 'high', value: high },
        ],
      };
    }

    // vector2 or fallback tuple
    const min = typeof param.min === 'number' && Number.isFinite(param.min) ? param.min : 0;
    const max = typeof param.max === 'number' && Number.isFinite(param.max) ? param.max : 1;
    const def = Array.isArray(param.defaultValue) ? [...param.defaultValue] : [0.5, 0.5];
    const low = [min, min];
    const high = [max, max];
    const midLeft = min + (max - min) * 0.2;
    const midRight = min + (max - min) * 0.8;
    const resetSeed =
      Math.hypot(def[0] - midLeft, def[1] - midRight) > 0.05 ? [midLeft, midRight] : high;
    return {
      key: param.key,
      label: param.label,
      type: param.type,
      defaultValue: def,
      resetSeed,
      cases: [
        { tag: 'low', value: low },
        { tag: 'default', value: def },
        { tag: 'high', value: high },
      ],
    };
  });
}

const KEYFRAME_PARAM_PRIORITY = [
  'amount',
  'intensity',
  'strength',
  'radius',
  'contrast',
  'saturation',
  'hue',
  'angle',
  'scale',
  'levels',
  'cellSize',
  'dotSize',
  'threshold',
];

/**
 * Pick the parameter to keyframe across 0s -> 2s, respecting LIBRARY-AUDIT.md rules.
 */
export function selectKeyframePlan(descriptor, auditEntry) {
  if (auditEntry?.keyframesPolicy === 'no') {
    return {
      skip: true,
      policy: 'no',
      reason: auditEntry.keyframesNote || 'Fixed parameters per LIBRARY-AUDIT.md',
    };
  }

  const numericAnimatable = descriptor.params.filter(
    (param) =>
      param.type === 'number' &&
      param.animatable !== false &&
      typeof param.min === 'number' &&
      typeof param.max === 'number' &&
      Number.isFinite(param.min) &&
      Number.isFinite(param.max) &&
      param.max > param.min,
  );

  if (numericAnimatable.length === 0) {
    return {
      skip: true,
      policy: auditEntry?.keyframesPolicy ?? 'no',
      reason: 'No animatable bounded scalar parameter on descriptor',
    };
  }

  let chosen;
  if (auditEntry?.keyframesPolicy === 'amount-only') {
    chosen = numericAnimatable.find((p) => p.key === 'amount') ?? numericAnimatable[0];
  } else {
    for (const preferredKey of KEYFRAME_PARAM_PRIORITY) {
      chosen = numericAnimatable.find((p) => p.key === preferredKey);
      if (chosen) break;
    }
    chosen ??= numericAnimatable[0];
  }

  return {
    skip: false,
    policy: auditEntry?.keyframesPolicy ?? 'yes',
    paramKey: chosen.key,
    paramLabel: chosen.label,
    startValue: chosen.min,
    endValue: chosen.max,
    expectedMidValue: (chosen.min + chosen.max) / 2,
  };
}
