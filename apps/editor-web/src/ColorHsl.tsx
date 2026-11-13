import { useEffect, useRef, useState } from 'react';
import type { ColorGradeV2, HslBand } from '@joy-media/project-schema';
import { HSL_BAND_IDS, IDENTITY_HSL_BANDS } from '@joy-media/project-schema';
import { PropertyRow, type PropertyAnimationState } from './components/PropertyRow.js';
import { colorGradePreview } from './color-grade-preview.js';
import {
  colorEyedropper,
  useColorEyedropperActive,
  type ColorEyedropperStore,
} from './color-eyedropper.js';
import {
  clampHslValue,
  formatHslValue,
  gradeHslBands,
  HSL_CONTROLS,
  hslBandChipColour,
  hslBandLabel,
  hslBandValue,
  identityHslBand,
  isIdentityHslBand,
  pickHslBand,
  withHslBandReset,
  withHslValue,
  type HslControl,
  type PickedColour,
} from './color-hsl-math.js';
import './ColorCurvesHsl.css';

export interface ColorHslProps {
  readonly draft: ColorGradeV2;
  /** The live value: the panel shows it straight away. */
  readonly onChange: (next: ColorGradeV2) => void;
  /** The durable value: one write, one undo step. */
  readonly onCommit: (next: ColorGradeV2) => void;
  readonly animationStateFor: (propertyId: string) => PropertyAnimationState;
  readonly onToggleAnimation: (propertyId: string, value: number, kind?: 'scalar' | 'hue') => void;
  readonly canAnimate: boolean;
  /** Which grade the bands change: the output grade or one clip's grade. */
  readonly scope?: 'output' | 'clip';
  readonly clipId?: string | undefined;
  readonly eyedropper?: ColorEyedropperStore;
}

type Status =
  | { readonly kind: 'picking' }
  | { readonly kind: 'picked'; readonly band: string; readonly hue: number }
  | { readonly kind: 'grey' };

function EyedropperIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
    >
      <path
        d="M10.4 2.6a1.9 1.9 0 0 1 2.7 2.7l-1.6 1.6.6.6-1.1 1.1-3.6-3.6 1.1-1.1.6.6 1.3-1.9Z"
        fill="currentColor"
      />
      <path
        d="m7.6 5.6-4.8 4.8-.6 2.6.8.8 2.6-.6 4.8-4.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A number box beside a slider: typing previews, Enter or leaving the box writes, Esc puts it back. */
function HslNumberBox({
  control,
  label,
  value,
  onPreview,
  onCommit,
}: {
  readonly control: HslControl;
  readonly label: string;
  readonly value: number;
  readonly onPreview: (value: number) => void;
  readonly onCommit: (value: number) => void;
}) {
  const [text, setText] = useState<string | undefined>(undefined);
  const startValue = useRef(value);
  const shown = control.step < 1 ? value.toFixed(2) : String(Math.round(value));
  const parse = (raw: string): number | undefined => {
    if (raw.trim() === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampHslValue(control.key, parsed) : undefined;
  };
  return (
    <input
      type="number"
      className="chsl-number"
      aria-label={`${label} value`}
      min={control.min}
      max={control.max}
      step={control.step}
      value={text ?? shown}
      onFocus={() => {
        startValue.current = value;
        setText(shown);
      }}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        setText(raw);
        const parsed = parse(raw);
        if (parsed !== undefined) onPreview(parsed);
      }}
      onBlur={(event) => {
        const parsed = parse(event.currentTarget.value);
        setText(undefined);
        onCommit(parsed ?? startValue.current);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          const parsed = parse(event.currentTarget.value);
          setText(undefined);
          onCommit(parsed ?? startValue.current);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setText(undefined);
          onCommit(startValue.current);
        }
      }}
    />
  );
}

/**
 * The HSL bands (T-K04).
 *
 * Each of the eight bands opens to Hue shift, Saturation, Luminance and Width
 * (and, under "Band shape", its centre and softness), each with a slider and
 * a number box, plus a reset for the band. The eyedropper in the header picks
 * a colour from the Monitor (read before the grade): the nearest band opens,
 * is highlighted and has its centre moved onto the picked hue. Sliders preview
 * live in the Monitor and write once when let go.
 */
export function ColorHsl({
  draft,
  onChange,
  onCommit,
  animationStateFor,
  onToggleAnimation,
  canAnimate,
  scope = 'output',
  clipId,
  eyedropper = colorEyedropper,
}: ColorHslProps) {
  const bands = gradeHslBands(draft.hsl);
  const picking = useColorEyedropperActive(eyedropper);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const sectionRef = useRef<HTMLElement>(null);
  // A pick lands later than the click that started it: it works on the grade
  // as it is then.
  const latest = useRef({ draft, onChange, onCommit });
  latest.current = { draft, onChange, onCommit };

  // The live grade stops when the panel goes away; so does a pick it started.
  useEffect(
    () => () => {
      colorGradePreview.set(undefined);
      eyedropper.cancel();
    },
    [eyedropper],
  );

  useEffect(() => {
    colorGradePreview.set(undefined);
  }, [scope, clipId]);

  // Esc cancels a pick even when no Monitor is on screen to catch it.
  useEffect(() => {
    if (!picking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') eyedropper.cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [picking, eyedropper]);

  useEffect(() => {
    if (!picking && status?.kind === 'picking') setStatus(undefined);
  }, [picking, status]);

  const gradeWith = (next: readonly HslBand[]): ColorGradeV2 => ({ ...draft, hsl: next });

  const preview = (next: readonly HslBand[]) => {
    const grade = gradeWith(next);
    onChange(grade);
    colorGradePreview.set({ scope, ...(clipId === undefined ? {} : { clipId }), grade });
  };

  const write = (next: readonly HslBand[]) => {
    const grade = gradeWith(next);
    onChange(grade);
    onCommit(grade);
    colorGradePreview.set(undefined);
  };

  const onPick = (colour: PickedColour) => {
    const current = latest.current;
    const result = pickHslBand(gradeHslBands(current.draft.hsl), colour);
    if (result === undefined) {
      setStatus({ kind: 'grey' });
      return;
    }
    const id = result.bands[result.index]!.id ?? HSL_BAND_IDS[result.index]!;
    const grade = { ...current.draft, hsl: result.bands };
    current.onChange(grade);
    current.onCommit(grade);
    colorGradePreview.set(undefined);
    setExpanded((open) => new Set([...open, id]));
    setHighlighted(id);
    setStatus({ kind: 'picked', band: hslBandLabel(id), hue: result.hue });
    const row = sectionRef.current?.querySelector(`[data-hsl-band="${id}"]`);
    if (row !== null && row !== undefined && typeof row.scrollIntoView === 'function')
      row.scrollIntoView({ block: 'nearest' });
  };

  const toggleEyedropper = () => {
    if (picking) {
      eyedropper.cancel();
      return;
    }
    setStatus({ kind: 'picking' });
    eyedropper.start(onPick);
  };

  const statusText =
    status === undefined
      ? undefined
      : status.kind === 'picking'
        ? 'Click a colour in the Monitor. Esc cancels.'
        : status.kind === 'grey'
          ? 'That pixel is grey: it has no hue to pick.'
          : `Picked ${status.hue}°: the ${status.band} band now centres on it.`;

  return (
    <section className="color-section chsl-section" ref={sectionRef}>
      <div className="chsl-header">
        <h3>Hue bands</h3>
        <button
          type="button"
          className="color-header-button chsl-eyedropper"
          aria-pressed={picking}
          aria-label="Pick a colour from the picture"
          title="Pick a colour from the picture"
          data-hsl-eyedropper=""
          onClick={toggleEyedropper}
        >
          <EyedropperIcon />
        </button>
      </div>
      {statusText !== undefined && (
        <p className="chsl-status" role="status" data-hsl-status="">
          {statusText}
        </p>
      )}
      {bands.map((band, index) => {
        const id = band.id ?? HSL_BAND_IDS[index]!;
        const label = hslBandLabel(id);
        const identity = identityHslBand(id);
        const open = expanded.has(id);
        const rows = (primary: boolean) =>
          HSL_CONTROLS.filter((control) => control.primary === primary).map((control) => {
            const value = hslBandValue(band, control.key);
            const propertyId = `hsl.${id}.${control.key}`;
            const controlId = `hsl-${id}-${control.key}`;
            const rowLabel = `${label} ${control.label}`;
            const resetValue = hslBandValue(identity, control.key);
            const set = (next: number, durable: boolean) => {
              const nextBands = withHslValue(bands, index, control.key, next);
              if (durable) write(nextBands);
              else preview(nextBands);
            };
            return (
              <PropertyRow
                key={control.key}
                label={rowLabel}
                controlId={controlId}
                value={formatHslValue(control, value)}
                onReset={() => set(resetValue, true)}
                {...(!canAnimate
                  ? {}
                  : {
                      animationState: animationStateFor(propertyId),
                      onToggleAnimation: () =>
                        onToggleAnimation(propertyId, value, control.valueKind),
                    })}
              >
                <div className="chsl-control">
                  <input
                    id={controlId}
                    aria-label={rowLabel}
                    type="range"
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    value={value}
                    data-hsl-control={control.key}
                    onChange={(event) => set(event.currentTarget.valueAsNumber, false)}
                    onPointerUp={(event) => set(event.currentTarget.valueAsNumber, true)}
                    onBlur={(event) => set(event.currentTarget.valueAsNumber, true)}
                    onKeyUp={(event) => {
                      if (
                        event.key.startsWith('Arrow') ||
                        event.key === 'Home' ||
                        event.key === 'End' ||
                        event.key === 'PageUp' ||
                        event.key === 'PageDown'
                      )
                        set(event.currentTarget.valueAsNumber, true);
                    }}
                    onDoubleClick={() => set(resetValue, true)}
                  />
                  <HslNumberBox
                    control={control}
                    label={rowLabel}
                    value={value}
                    onPreview={(next) => set(next, false)}
                    onCommit={(next) => set(next, true)}
                  />
                </div>
              </PropertyRow>
            );
          });
        return (
          <details
            key={id}
            className={`chsl-band${highlighted === id ? ' is-picked' : ''}`}
            data-hsl-band={id}
            open={open}
            onToggle={(event) => {
              const isOpen = event.currentTarget.open;
              if (isOpen === open) return;
              setExpanded((current) => {
                const next = new Set(current);
                if (isOpen) next.add(id);
                else next.delete(id);
                return next;
              });
              if (!isOpen && highlighted === id) setHighlighted(undefined);
            }}
          >
            <summary>
              <span
                className="chsl-chip"
                style={{ background: hslBandChipColour(band.hue) }}
                title={`Band centre ${Math.round(band.hue)}°`}
                aria-hidden="true"
                data-hsl-chip={id}
              />
              <strong>{label}</strong>
              <span className="chsl-centre">{Math.round(band.hue)}° centre</span>
              {!isIdentityHslBand(band, index) && (
                <span className="chsl-modified" aria-label={`${label} band is changed`}>
                  ●
                </span>
              )}
            </summary>
            <div className="chsl-band-controls">
              {rows(true)}
              <div className="chsl-shape">
                <span className="chsl-shape-title">Band shape</span>
                {rows(false)}
              </div>
              <button
                type="button"
                className="section-reset"
                disabled={isIdentityHslBand(band, index)}
                onClick={() => write(withHslBandReset(bands, index))}
              >
                Reset {label} band
              </button>
            </div>
          </details>
        );
      })}
      <button
        type="button"
        className="section-reset"
        onClick={() => {
          write(IDENTITY_HSL_BANDS);
          setHighlighted(undefined);
        }}
      >
        Reset hue bands
      </button>
    </section>
  );
}
