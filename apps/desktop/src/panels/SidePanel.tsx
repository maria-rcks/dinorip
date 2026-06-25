import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { defaultTextureAdjustments } from "@dinorip/core";
import type { DitherMode, PixelImage } from "@dinorip/core";
import type { TextureSettings, WorkspaceImageState } from "../renderer/types";
import { ShaderPreview } from "../preview/ShaderPreview";
import { TexturePreview } from "../preview/TexturePreview";

interface SidePanelProps {
  selectedImage?: WorkspaceImageState;
  textureCount: number;
  computeAdjusted(image: PixelImage, settings: TextureSettings): Promise<PixelImage>;
  onApply(): void;
  onApplyToAll(): void;
  onUpdateSettings(settings: TextureSettings): void;
}

type TabId = "color" | "quantize" | "presets";

// A saved bundle of effect settings, persisted to localStorage so it survives
// restarts and can be reused across textures.
interface EffectPreset {
  id: string;
  name: string;
  settings: TextureSettings;
}

const PRESETS_KEY = "dinorip.effectPresets.v1";

export function SidePanel(props: SidePanelProps): ReactElement {
  const selected = props.selectedImage;
  const settings = selected?.settings;
  const disabled = !selected;
  const [tab, setTab] = useState<TabId>("color");
  const [presets, setPresets] = usePresets();
  const [presetName, setPresetName] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId),
    [presets, selectedPresetId]
  );

  const updateSettings = (patch: Partial<TextureSettings>) => {
    if (!selected) return;
    props.onUpdateSettings({ ...selected.settings, ...patch });
  };

  const resetSettings = () => {
    if (!selected) return;
    props.onUpdateSettings({ ...defaultTextureAdjustments });
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name || !settings) return;
    const existing = presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
    const snapshot = { ...settings };
    if (existing) {
      setPresets(presets.map((preset) => preset.id === existing.id ? { ...preset, settings: snapshot } : preset));
      setSelectedPresetId(existing.id);
    } else {
      const id = `preset-${Math.random().toString(36).slice(2)}`;
      setPresets([...presets, { id, name, settings: snapshot }]);
      setSelectedPresetId(id);
    }
    setPresetName("");
  };

  const applyPreset = () => {
    if (!selectedPreset || !selected) return;
    // Merge over defaults so presets saved before a field existed still load.
    props.onUpdateSettings({ ...defaultTextureAdjustments, ...selectedPreset.settings });
  };

  const deletePreset = () => {
    if (!selectedPreset) return;
    setPresets(presets.filter((preset) => preset.id !== selectedPreset.id));
    setSelectedPresetId("");
  };

  return (
    <aside className="seam-options">
      <div className="seam-options__frame">
        <header className="seam-options__title">
          <span className="seam-options__title-text">Texture Options</span>
          <span className="seam-options__title-dots" aria-hidden="true" />
          <div className="seam-tabs" role="tablist">
            <TabButton id="color" label="Color" active={tab} onSelect={setTab} />
            <TabButton id="quantize" label="Quantize" active={tab} onSelect={setTab} />
            <TabButton id="presets" label="Presets" active={tab} onSelect={setTab} />
          </div>
        </header>

        <div className="seam-options__body">
          <div className="seam-options__preview">
            {selected ? (
              <TexturePreview
                image={selected.originalImage}
                settings={selected.settings}
                version={selected.version}
                computeAdjusted={props.computeAdjusted}
              />
            ) : (
              <ShaderPreview />
            )}
          </div>

          <div className="seam-options__controls">
            {tab === "color" && (
              <div className="seam-tabpanel" role="tabpanel">
                <PixelSlider
                  label="Brightness"
                  min={-1}
                  max={1}
                  step={0.02}
                  value={settings?.brightness ?? 0}
                  disabled={disabled}
                  format={formatSigned}
                  onChange={(value) => updateSettings({ brightness: value })}
                />
                <PixelSlider
                  label="Contrast"
                  min={-1}
                  max={1}
                  step={0.02}
                  value={settings?.contrast ?? 0}
                  disabled={disabled}
                  format={formatSigned}
                  onChange={(value) => updateSettings({ contrast: value })}
                />
                <PixelSlider
                  label="Saturation"
                  min={-1}
                  max={1}
                  step={0.02}
                  value={settings?.saturation ?? 0}
                  disabled={disabled || settings?.grayscale}
                  format={formatSigned}
                  onChange={(value) => updateSettings({ saturation: value })}
                />
                <PixelSlider
                  label="Hue Shift"
                  min={-180}
                  max={180}
                  step={1}
                  value={settings?.hue ?? 0}
                  disabled={disabled}
                  format={(value) => `${Math.round(value)}°`}
                  onChange={(value) => updateSettings({ hue: value })}
                />
                <div className="seam-checks seam-checks--row">
                  <PixelCheck
                    label="Grayscale"
                    checked={settings?.grayscale ?? false}
                    disabled={disabled}
                    onChange={(value) => updateSettings({ grayscale: value })}
                  />
                  <PixelCheck
                    label="Invert"
                    checked={settings?.invert ?? false}
                    disabled={disabled}
                    onChange={(value) => updateSettings({ invert: value })}
                  />
                  <PixelCheck
                    label="Sharpen"
                    checked={settings?.sharpen ?? false}
                    disabled={disabled}
                    onChange={(value) => updateSettings({ sharpen: value })}
                  />
                </div>
              </div>
            )}

            {tab === "quantize" && (
              <div className="seam-tabpanel" role="tabpanel">
                <PixelSlider
                  label="Posterize Levels"
                  min={0}
                  max={32}
                  step={1}
                  value={settings?.posterizeLevels ?? 0}
                  disabled={disabled}
                  format={(value) => (value < 2 ? "Off" : `${Math.round(value)}`)}
                  onChange={(value) => updateSettings({ posterizeLevels: value })}
                />
                <PixelCheck
                  label="Dither"
                  checked={settings?.dither ?? false}
                  disabled={disabled || !(settings && settings.posterizeLevels >= 2)}
                  onChange={(value) => updateSettings({ dither: value })}
                />
                <div className="seam-field">
                  <span className="seam-field__label">Dither Mode</span>
                  <div className="seam-select">
                    <select
                      value={settings?.ditherMode ?? "ordered"}
                      disabled={disabled || !settings?.dither}
                      onChange={(event) => updateSettings({ ditherMode: event.target.value as DitherMode })}
                    >
                      <option value="ordered">Ordered (Bayer)</option>
                      <option value="floyd">Floyd–Steinberg</option>
                    </select>
                  </div>
                </div>
                <PixelSlider
                  label="Dither Amount"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings?.ditherAmount ?? 1}
                  disabled={disabled || !settings?.dither || settings?.ditherMode !== "ordered"}
                  format={(value) => `${Math.round(value * 100)}%`}
                  onChange={(value) => updateSettings({ ditherAmount: value })}
                />
                <span className="seam-hint">Dither strength applies to Ordered mode. Floyd–Steinberg diffuses error automatically.</span>
              </div>
            )}

            {tab === "presets" && (
              <div className="seam-tabpanel seam-presets" role="tabpanel">
                <div className="seam-preset-row">
                  <div className="seam-select seam-select--grow">
                    <select
                      value={selectedPresetId}
                      onChange={(event) => setSelectedPresetId(event.target.value)}
                    >
                      <option value="">{presets.length ? "— Select preset —" : "No saved presets"}</option>
                      {presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.name}</option>
                      ))}
                    </select>
                  </div>
                  <button className="seam-btn" type="button" disabled={disabled || !selectedPreset} onClick={applyPreset}>Apply</button>
                  <button className="seam-btn seam-btn--danger" type="button" disabled={!selectedPreset} onClick={deletePreset} title="Delete preset">✕</button>
                </div>

                <div className="seam-preset-row">
                  <input
                    className="seam-preset-input"
                    type="text"
                    placeholder="Name this effect set"
                    value={presetName}
                    disabled={disabled}
                    onChange={(event) => setPresetName(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") savePreset(); }}
                  />
                  <button className="seam-btn" type="button" disabled={disabled || !presetName.trim()} onClick={savePreset}>Save</button>
                </div>

                <span className="seam-divider seam-divider--h" aria-hidden="true" />

                <button
                  className="seam-btn seam-btn--wide"
                  type="button"
                  disabled={disabled || props.textureCount < 2}
                  onClick={props.onApplyToAll}
                  title="Copy these settings onto every texture and bake them"
                >
                  Apply to All Textures
                </button>
                <button className="seam-btn seam-btn--wide" type="button" disabled={disabled} onClick={resetSettings}>
                  Reset Effects
                </button>
              </div>
            )}

            <div className="seam-footer">
              <button className="seam-apply" type="button" onClick={props.onApply} disabled={disabled} title="Apply adjustments (S)">
                Apply
              </button>
              <span className="seam-shortcut">Shortcut: S</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// Load/save named presets to localStorage. The state initialiser reads once on
// mount and every change is written back.
function usePresets(): [EffectPreset[], (next: EffectPreset[]) => void] {
  const [presets, setPresets] = useState<EffectPreset[]>(() => loadPresets());
  useEffect(() => {
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
    } catch {
      // Ignore quota / unavailable storage; presets simply stay in-memory.
    }
  }, [presets]);
  return [presets, setPresets];
}

function loadPresets(): EffectPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is EffectPreset =>
        Boolean(item) && typeof item.id === "string" && typeof item.name === "string" && typeof item.settings === "object")
      .map((item) => ({ ...item, settings: { ...defaultTextureAdjustments, ...item.settings } }));
  } catch {
    return [];
  }
}

// Format a -1..1 adjustment as a signed percentage, e.g. +20% / -40% / 0%.
function formatSigned(value: number): string {
  const percent = Math.round(value * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
}

function TabButton(props: { id: TabId; label: string; active: TabId; onSelect(id: TabId): void }) {
  const isActive = props.active === props.id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      className={["seam-tab", isActive ? "seam-tab--active" : ""].filter(Boolean).join(" ")}
      onClick={() => props.onSelect(props.id)}
    >
      {props.label}
    </button>
  );
}

function PixelSlider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  className?: string;
  format?(value: number): string;
  onChange(value: number): void;
}) {
  const ratio = props.max > props.min ? (props.value - props.min) / (props.max - props.min) : 0;
  const fill = Math.max(0, Math.min(1, ratio)) * 100;
  const readout = props.format ? props.format(props.value) : String(props.value);
  return (
    <label className={["pslider", props.className, props.disabled ? "pslider--disabled" : ""].filter(Boolean).join(" ")}>
      <span className="pslider__track" aria-hidden="true" />
      <span className="pslider__fill" style={{ width: `${fill}%` }} aria-hidden="true" />
      <span className="pslider__label">{props.label}</span>
      <span className="pslider__value" aria-hidden="true">{readout}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

function PixelCheck(props: { label: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void }) {
  return (
    <label className={["pcheck", props.disabled ? "pcheck--disabled" : ""].filter(Boolean).join(" ")}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="pcheck__box" aria-hidden="true" />
      <span className="pcheck__label">{props.label}</span>
    </label>
  );
}
