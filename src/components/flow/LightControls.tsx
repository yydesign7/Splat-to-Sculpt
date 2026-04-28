'use client';

import { RotateCcw } from 'lucide-react';
import type { LightParams } from './custom-nodes';
import { DEFAULT_LIGHT_PARAMS } from './custom-nodes';

interface LightControlsProps {
  lightParams: LightParams;
  onChange: (params: LightParams) => void;
  /** When true, all sliders/buttons are disabled (e.g. Blender or preview merge in progress). */
  disabled?: boolean;
}

function rgbToHex(rgb: [number, number, number]): string {
  const toHex = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    const hex = Math.round(clamped * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [1, 1, 1];
  return [
    parseInt(result[1], 16) / 255,
    parseInt(result[2], 16) / 255,
    parseInt(result[3], 16) / 255,
  ];
}

export function LightControls({ lightParams, onChange, disabled = false }: LightControlsProps) {
  const update = <K extends keyof LightParams>(key: K, value: LightParams[K]) => {
    onChange({ ...lightParams, [key]: value });
  };

  const reset = () => {
    onChange({ ...DEFAULT_LIGHT_PARAMS });
  };

  const rangeCls = `h-1 w-16 nodrag accent-[#9a8a6a] ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`;
  const rangeClsFill = `h-1 w-16 nodrag accent-[#6a9a8a] ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`;
  const rangeClsExp = `h-1 w-16 nodrag accent-[#8a7a6a] ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`;
  const colorCls = `h-5 w-5 rounded border border-zinc-600 bg-transparent nodrag ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`;

  return (
    <div
      className={`space-y-1.5 rounded-md border border-zinc-600/60 bg-zinc-800/80 p-2 ${disabled ? 'opacity-80' : ''}`}
      aria-busy={disabled || undefined}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-[#9a8a6a]">
          Light Settings
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => { e.stopPropagation(); reset(); }}
          className="flex h-4 w-4 items-center justify-center rounded text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 disabled:pointer-events-none disabled:opacity-40"
          title="Reset lights"
        >
          <RotateCcw size={9} />
        </button>
      </div>

      {/* Ambient Intensity */}
      <LightParamRow label="Ambient">
        <div className="flex items-center gap-1.5">
          <input
            type="range"
            min="0"
            max="3"
            step="0.05"
            value={lightParams.ambientIntensity}
            disabled={disabled}
            onChange={(e) => { e.stopPropagation(); update('ambientIntensity', parseFloat(e.target.value)); }}
            onClick={(e) => e.stopPropagation()}
            className={rangeCls}
          />
          <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
            {lightParams.ambientIntensity.toFixed(2)}
          </span>
        </div>
      </LightParamRow>

      {/* ---- Main Light Section ---- */}
      <div className="mt-1 mb-0.5 border-t border-zinc-700/50 pt-1">
        <span className="text-[8px] font-semibold uppercase tracking-wider text-[#8a9a6a]">
          Main Light
        </span>
      </div>

      {/* Main Light Intensity */}
      <LightParamRow label="Intensity">
        <div className="flex items-center gap-1.5">
          <input
            type="range"
            min="0"
            max="10"
            step="0.1"
            value={lightParams.mainLightIntensity}
            disabled={disabled}
            onChange={(e) => { e.stopPropagation(); update('mainLightIntensity', parseFloat(e.target.value)); }}
            onClick={(e) => e.stopPropagation()}
            className={rangeCls}
          />
          <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
            {lightParams.mainLightIntensity.toFixed(1)}
          </span>
        </div>
      </LightParamRow>

      {/* Main Light Color */}
      <LightParamRow label="Color">
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            value={rgbToHex(lightParams.mainLightColor)}
            disabled={disabled}
            onChange={(e) => { e.stopPropagation(); update('mainLightColor', hexToRgb(e.target.value)); }}
            onClick={(e) => e.stopPropagation()}
            className={colorCls}
          />
          <span className="text-[9px] text-zinc-500 font-mono">
            {rgbToHex(lightParams.mainLightColor)}
          </span>
        </div>
      </LightParamRow>

      {/* Main Light Azimuth */}
      <LightParamRow label="Azimuth">
        <div className="flex items-center gap-1.5">
          <input
            type="range"
            min="0"
            max="360"
            step="1"
            value={lightParams.mainLightAzimuth}
            disabled={disabled}
            onChange={(e) => { e.stopPropagation(); update('mainLightAzimuth', parseFloat(e.target.value)); }}
            onClick={(e) => e.stopPropagation()}
            className={rangeCls}
          />
          <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
            {Math.round(lightParams.mainLightAzimuth)}°
          </span>
        </div>
      </LightParamRow>

      {/* Main Light Elevation */}
      <LightParamRow label="Elevation">
        <div className="flex items-center gap-1.5">
          <input
            type="range"
            min="0"
            max="90"
            step="1"
            value={lightParams.mainLightElevation}
            disabled={disabled}
            onChange={(e) => { e.stopPropagation(); update('mainLightElevation', parseFloat(e.target.value)); }}
            onClick={(e) => e.stopPropagation()}
            className={rangeCls}
          />
          <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
            {Math.round(lightParams.mainLightElevation)}°
          </span>
        </div>
      </LightParamRow>

      {/* ---- Fill Light Section ---- */}
      <div className="mt-1 mb-0.5 border-t border-zinc-700/50 pt-1">
        <span className="text-[8px] font-semibold uppercase tracking-wider text-[#6a9a8a]">
          Fill Light
        </span>
      </div>

      {/* Fill Light Intensity */}
      <LightParamRow label="Intensity">
        <div className="flex items-center gap-1.5">
          <input
            type="range"
            min="0"
            max="5"
            step="0.1"
            value={lightParams.fillLightIntensity}
            disabled={disabled}
            onChange={(e) => { e.stopPropagation(); update('fillLightIntensity', parseFloat(e.target.value)); }}
            onClick={(e) => e.stopPropagation()}
            className={rangeClsFill}
          />
          <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
            {lightParams.fillLightIntensity.toFixed(1)}
          </span>
        </div>
      </LightParamRow>

      {/* Fill Light Azimuth */}
      <LightParamRow label="Azimuth">
        <div className="flex items-center gap-1.5">
          <input
            type="range"
            min="0"
            max="360"
            step="1"
            value={lightParams.fillLightAzimuth}
            disabled={disabled}
            onChange={(e) => { e.stopPropagation(); update('fillLightAzimuth', parseFloat(e.target.value)); }}
            onClick={(e) => e.stopPropagation()}
            className={rangeClsFill}
          />
          <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
            {Math.round(lightParams.fillLightAzimuth)}°
          </span>
        </div>
      </LightParamRow>

      {/* Fill Light Elevation */}
      <LightParamRow label="Elevation">
        <div className="flex items-center gap-1.5">
          <input
            type="range"
            min="0"
            max="90"
            step="1"
            value={lightParams.fillLightElevation}
            disabled={disabled}
            onChange={(e) => { e.stopPropagation(); update('fillLightElevation', parseFloat(e.target.value)); }}
            onClick={(e) => e.stopPropagation()}
            className={rangeClsFill}
          />
          <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
            {Math.round(lightParams.fillLightElevation)}°
          </span>
        </div>
      </LightParamRow>

      {/* ---- Rendering Section ---- */}
      <div className="mt-1 mb-0.5 border-t border-zinc-700/50 pt-1">
        <span className="text-[8px] font-semibold uppercase tracking-wider text-[#8a7a6a]">
          Rendering
        </span>
      </div>

      {/* Exposure */}
      <LightParamRow label="Exposure">
        <div className="flex items-center gap-1.5">
          <input
            type="range"
            min="0.1"
            max="3"
            step="0.05"
            value={lightParams.exposure}
            disabled={disabled}
            onChange={(e) => { e.stopPropagation(); update('exposure', parseFloat(e.target.value)); }}
            onClick={(e) => e.stopPropagation()}
            className={rangeClsExp}
          />
          <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
            {lightParams.exposure.toFixed(2)}
          </span>
        </div>
      </LightParamRow>
    </div>
  );
}

function LightParamRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-[9px] text-zinc-400">{label}</span>
      <div className="flex-1 flex justify-end">{children}</div>
    </div>
  );
}
