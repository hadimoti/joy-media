/**
 * DaVinci-shaped color grade — icon-led controls with hover guides.
 */

import { useState } from 'react';
import type { ColorGradeV1, JoyProjectV1 } from '@joy-media/project-schema';
import {
  BlendIcon,
  ContrastIcon,
  GainIcon,
  GammaIcon,
  InvertColorIcon,
  LiftIcon,
  RefreshIcon,
  SaturationIcon,
} from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

const TABS: readonly PanelTabSpec[] = [
  { id: 'grade', label: 'Grade' },
  { id: 'lut', label: 'LUT' },
  { id: 'scopes', label: 'Scopes' },
];

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

const LUT_ICONS = {
  none: InvertColorIcon,
  rec709: BlendIcon,
  contrast: ContrastIcon,
} as const;

export function ColorPanel({ project, onChange }: ColorPanelProps) {
  const [tab, setTab] = useState('grade');
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

  const isDefault =
    grade.lift === DEFAULT_GRADE.lift &&
    grade.gamma === DEFAULT_GRADE.gamma &&
    grade.gain === DEFAULT_GRADE.gain &&
    grade.saturation === DEFAULT_GRADE.saturation &&
    (grade.lutId ?? 'none') === DEFAULT_GRADE.lutId;

  return (
    <PanelShell
      title="Color"
      iconUrl={panelTabIconUrl('color')}
      className="color-panel"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      actions={
        <button
          type="button"
          className="icon-button"
          aria-label="Reset grade"
          title="Reset grade"
          disabled={isDefault}
          onClick={() => set(DEFAULT_GRADE)}
        >
          <RefreshIcon />
        </button>
      }
    >
      {tab === 'grade' && (
        <>
      <div className="control-row">
        <span className="icon-tool" data-guide="Lift" aria-hidden="true">
          <LiftIcon />
        </span>
        <input
          type="range"
          min={-0.5}
          max={0.5}
          step={0.01}
          value={grade.lift}
          aria-label="Lift"
          title="Lift"
          onChange={(event) => set({ lift: event.currentTarget.valueAsNumber })}
        />
        <span className="value">{grade.lift.toFixed(2)}</span>
      </div>
      <div className="control-row">
        <span className="icon-tool" data-guide="Gamma" aria-hidden="true">
          <GammaIcon />
        </span>
        <input
          type="range"
          min={0.5}
          max={1.5}
          step={0.01}
          value={grade.gamma}
          aria-label="Gamma"
          title="Gamma"
          onChange={(event) => set({ gamma: event.currentTarget.valueAsNumber })}
        />
        <span className="value">{grade.gamma.toFixed(2)}</span>
      </div>
      <div className="control-row">
        <span className="icon-tool" data-guide="Gain" aria-hidden="true">
          <GainIcon />
        </span>
        <input
          type="range"
          min={0.5}
          max={1.5}
          step={0.01}
          value={grade.gain}
          aria-label="Gain"
          title="Gain"
          onChange={(event) => set({ gain: event.currentTarget.valueAsNumber })}
        />
        <span className="value">{grade.gain.toFixed(2)}</span>
      </div>
      <div className="control-row">
        <span className="icon-tool" data-guide="Saturation" aria-hidden="true">
          <SaturationIcon />
        </span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={grade.saturation}
          aria-label="Saturation"
          title="Saturation"
          onChange={(event) => set({ saturation: event.currentTarget.valueAsNumber })}
        />
        <span className="value">{grade.saturation.toFixed(2)}</span>
      </div>
        </>
      )}

      {tab === 'lut' && (
        <div className="preset-icon-group" role="group" aria-label="LUT">
          {(
            [
              ['none', 'No LUT'],
              ['rec709', 'Rec.709'],
              ['contrast', 'Contrast'],
            ] as const
          ).map(([id, label]) => {
            const Icon = LUT_ICONS[id];
            return (
              <button
                key={id}
                type="button"
                className="icon-button"
                aria-pressed={(grade.lutId ?? 'none') === id}
                aria-label={label}
                data-guide={label}
                title={label}
                onClick={() => set({ lutId: id })}
              >
                <Icon />
              </button>
            );
          })}
        </div>
      )}

      {tab === 'scopes' && (
        <div className="color-scopes" aria-label="Parade scope">
          <div className="scope-bar scope-r" style={{ height: scopeHeight(grade.gain, 1) }} />
          <div className="scope-bar scope-g" style={{ height: scopeHeight(grade.gamma, 1) }} />
          <div className="scope-bar scope-b" style={{ height: scopeHeight(grade.lift + 1, 1) }} />
        </div>
      )}
    </PanelShell>
  );
}
