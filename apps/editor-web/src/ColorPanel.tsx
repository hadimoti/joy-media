/**
 * DaVinci-shaped color grade panel: lift/gamma/gain/sat + LUT + simple scopes.
 */

import type { ColorGradeV1, JoyProjectV1 } from '@joy-media/project-schema';

export const DEFAULT_GRADE: ColorGradeV1 = {
  lift: 0,
  gamma: 1,
  gain: 1,
  saturation: 1,
  lutId: 'none',
};

export function readColorGrade(project: JoyProjectV1): ColorGradeV1 {
  const raw = project.colorGrade;
  if (raw === undefined) return DEFAULT_GRADE;
  return { ...DEFAULT_GRADE, ...raw };
}

interface ColorPanelProps {
  readonly project: JoyProjectV1;
  readonly onChange: (next: JoyProjectV1) => void;
}

export function ColorPanel({ project, onChange }: ColorPanelProps) {
  const grade = readColorGrade(project);
  const set = (patch: Partial<ColorGradeV1>) => {
    onChange({
      ...project,
      colorGrade: { ...grade, ...patch },
      updatedAt: new Date().toISOString(),
    });
  };

  const scopeHeight = (value: number, mid: number) =>
    `${Math.max(8, Math.min(100, 40 + (value - mid) * 40))}%`;

  return (
    <article className="color-panel">
      <h3>Color</h3>
      <label>
        Lift
        <input
          type="range"
          min={-0.5}
          max={0.5}
          step={0.01}
          value={grade.lift}
          onChange={(event) => set({ lift: event.currentTarget.valueAsNumber })}
        />
      </label>
      <label>
        Gamma
        <input
          type="range"
          min={0.5}
          max={1.5}
          step={0.01}
          value={grade.gamma}
          onChange={(event) => set({ gamma: event.currentTarget.valueAsNumber })}
        />
      </label>
      <label>
        Gain
        <input
          type="range"
          min={0.5}
          max={1.5}
          step={0.01}
          value={grade.gain}
          onChange={(event) => set({ gain: event.currentTarget.valueAsNumber })}
        />
      </label>
      <label>
        Saturation
        <input
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={grade.saturation}
          onChange={(event) => set({ saturation: event.currentTarget.valueAsNumber })}
        />
      </label>
      <label>
        LUT
        <select
          value={grade.lutId ?? 'none'}
          onChange={(event) => {
            const lutId = event.currentTarget.value as 'none' | 'rec709' | 'contrast';
            set({ lutId });
          }}
        >
          <option value="none">None</option>
          <option value="rec709">Rec.709</option>
          <option value="contrast">Contrast</option>
        </select>
      </label>
      <div className="color-scopes" aria-label="Parade scope">
        <div className="scope-bar scope-r" style={{ height: scopeHeight(grade.gain, 1) }} />
        <div className="scope-bar scope-g" style={{ height: scopeHeight(grade.gamma, 1) }} />
        <div className="scope-bar scope-b" style={{ height: scopeHeight(grade.lift + 1, 1) }} />
      </div>
      <p className="empty-hint">
        Grade persists on the project. Preview/export color path applies as renderer support lands.
      </p>
    </article>
  );
}
