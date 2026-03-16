"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { expandPresets, getExcludePresets, getWhitelistPresets } from "@/lib/filter-presets";
import { validateRegexPattern } from "@/lib/backup-filter";
import type { ExcludeMode, FilterPattern, IceBoxFilterConfig, PatternType } from "@/types";

interface BackupFilterConfigProps {
  value: IceBoxFilterConfig;
  onChange: (config: IceBoxFilterConfig) => void;
  disabled?: boolean;
}

interface RuleRow {
  id: string;
  source: "preset" | "custom";
  presetId?: string;
  pattern: FilterPattern;
  customIndex?: number;
}

const modeOrder: ExcludeMode[] = ["disabled", "blacklist", "whitelist"];
const patternTypeOptions: PatternType[] = ["glob", "regex"];

export function BackupFilterConfig({ value, onChange, disabled = false }: BackupFilterConfigProps) {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
  const [draftPattern, setDraftPattern] = useState("");
  const [draftType, setDraftType] = useState<PatternType>("glob");

  const presetOptions = useMemo(
    () => (value.mode === "whitelist" ? getWhitelistPresets() : getExcludePresets()),
    [value.mode],
  );

  const regexValidation = useMemo(() => {
    if (draftType !== "regex" || !draftPattern.trim()) {
      return { valid: true, error: null as string | null };
    }

    return validateRegexPattern(draftPattern.trim());
  }, [draftPattern, draftType]);

  const ruleRows = useMemo<RuleRow[]>(() => {
    const presetMap = new Map(presetOptions.map((preset) => [preset.id, preset]));
    const presetRows: RuleRow[] = [];

    for (const presetId of value.presets) {
      const preset = presetMap.get(presetId);
      if (!preset) {
        continue;
      }

      for (const pattern of preset.patterns) {
        presetRows.push({
          id: `preset:${presetId}:${pattern.type}:${pattern.pattern}`,
          source: "preset",
          presetId,
          pattern,
        });
      }
    }

    const customRows = value.patterns.map((pattern, index) => ({
      id: `custom:${index}:${pattern.type}:${pattern.pattern}`,
      source: "custom" as const,
      customIndex: index,
      pattern,
    }));

    return [...presetRows, ...customRows];
  }, [presetOptions, value.patterns, value.presets]);

  const selectedPresetPatterns = useMemo(
    () => expandPresets(value.presets, presetOptions),
    [presetOptions, value.presets],
  );

  const allPatterns = useMemo(() => {
    const seen = new Set<string>();
    const merged: FilterPattern[] = [];

    for (const pattern of [...selectedPresetPatterns, ...value.patterns]) {
      const key = `${pattern.type}:${pattern.pattern}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(pattern);
    }

    return merged;
  }, [selectedPresetPatterns, value.patterns]);

  const canAddCustomRule = Boolean(draftPattern.trim()) && regexValidation.valid && value.mode !== "disabled" && !disabled;

  function updateConfig(patch: Partial<IceBoxFilterConfig>) {
    onChange({ ...value, ...patch });
  }

  function handleModeChange(mode: ExcludeMode) {
    if (mode === value.mode) {
      return;
    }

    onChange({
      ...value,
      mode,
      presets: [],
      patterns: [],
    });
  }

  function handlePresetToggle(presetId: string) {
    if (disabled || value.mode === "disabled") {
      return;
    }

    const presets = value.presets.includes(presetId)
      ? value.presets.filter((id) => id !== presetId)
      : [...value.presets, presetId];

    updateConfig({ presets });
  }

  function handleAddRule() {
    const pattern = draftPattern.trim();
    if (!pattern || !regexValidation.valid || value.mode === "disabled") {
      return;
    }

    updateConfig({
      patterns: [...value.patterns, { pattern, type: draftType }],
    });
    setDraftPattern("");
    setDraftType("glob");
  }

  function handleDeleteRow(row: RuleRow) {
    if (disabled) {
      return;
    }

    if (row.source === "preset" && row.presetId) {
      updateConfig({ presets: value.presets.filter((id) => id !== row.presetId) });
      return;
    }

    if (typeof row.customIndex === "number") {
      updateConfig({
        patterns: value.patterns.filter((_, index) => index !== row.customIndex),
      });
    }
  }

  return (
    <div className="rounded-[24px] border border-zinc-200/80 bg-white/80 shadow-sm shadow-black/5 backdrop-blur dark:border-white/10 dark:bg-white/5">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((open) => !open)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-base">📁</span>
            <h3 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">{t("home.filter.title")}</h3>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{t("home.filter.description", { count: allPatterns.length })}</p>
        </div>
        <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {isOpen ? t("common.collapse") : t("common.expand")}
          <span className="ml-1">{isOpen ? "▴" : "▾"}</span>
        </span>
      </button>

      {isOpen ? (
        <div className="grid gap-5 border-t border-zinc-200/80 px-5 py-5 dark:border-white/10">
          <div className="space-y-3">
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("home.filter.modeLabel")}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {modeOrder.map((mode) => {
                const active = value.mode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={disabled}
                    onClick={() => handleModeChange(mode)}
                    className={[
                      "rounded-[20px] border p-4 text-left transition",
                      active
                        ? "border-sky-400/40 bg-sky-500/10 shadow-sm shadow-sky-500/10"
                        : "border-zinc-200/80 bg-white/72 hover:border-sky-300/30 dark:border-white/10 dark:bg-white/5",
                      disabled ? "cursor-not-allowed opacity-60" : "",
                    ].join(" ")}
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 text-sm">{active ? "●" : "○"}</span>
                      <div className="space-y-1">
                        <p className="font-semibold text-zinc-950 dark:text-zinc-50">{t(`home.filter.modes.${mode}.title`)}</p>
                        <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">{t(`home.filter.modes.${mode}.description`)}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {value.mode === "whitelist" ? (
            <div className="fridge-state fridge-state--warning">
              <p className="font-medium">{t("home.filter.whitelistNoticeTitle")}</p>
              <p className="mt-1 opacity-90">{t("home.filter.whitelistNoticeDescription")}</p>
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("home.filter.presetsLabel")}</p>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{t("home.filter.selectedPresets", { count: value.presets.length })}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {presetOptions.map((preset) => {
                const active = value.presets.includes(preset.id);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={disabled || value.mode === "disabled"}
                    onClick={() => handlePresetToggle(preset.id)}
                    className={[
                      "rounded-full border px-3 py-2 text-sm transition",
                      active
                        ? "border-sky-400/40 bg-sky-500/10 text-sky-700 shadow-sm shadow-sky-500/10 dark:text-sky-200"
                        : "border-zinc-200/80 bg-white/72 text-zinc-700 hover:border-sky-300/30 dark:border-white/10 dark:bg-white/5 dark:text-zinc-200",
                      disabled || value.mode === "disabled" ? "cursor-not-allowed opacity-60" : "",
                    ].join(" ")}
                    title={preset.description}
                  >
                    {preset.name}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="inline-flex items-center gap-3 text-sm text-zinc-700 dark:text-zinc-200">
            <input
              type="checkbox"
              checked={value.inheritGitignore}
              disabled={disabled}
              onChange={(event) => updateConfig({ inheritGitignore: event.target.checked })}
              className="h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
            />
            <span>{t("home.filter.inheritGitignore")}</span>
          </label>

          <div className="grid gap-3 rounded-[20px] border border-zinc-200/80 bg-zinc-50/70 p-4 dark:border-white/10 dark:bg-zinc-950/30">
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("home.filter.customRuleLabel")}</p>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
              <input
                value={draftPattern}
                disabled={disabled || value.mode === "disabled"}
                onChange={(event) => setDraftPattern(event.target.value)}
                placeholder={t("home.filter.customRulePlaceholder")}
                className="fridge-input text-sm"
              />
              <select
                value={draftType}
                disabled={disabled || value.mode === "disabled"}
                onChange={(event) => setDraftType(event.target.value as PatternType)}
                className="fridge-input text-sm"
              >
                {patternTypeOptions.map((option) => (
                  <option key={option} value={option}>
                    {t(`home.filter.patternTypes.${option}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!canAddCustomRule}
                onClick={handleAddRule}
                className="fridge-button-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("home.filter.addRule")}
              </button>
            </div>
            {draftType === "regex" && draftPattern.trim() && !regexValidation.valid ? (
              <p className="text-sm text-rose-500">{regexValidation.error ?? t("home.filter.invalidRegex")}</p>
            ) : null}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("home.filter.ruleListLabel")}</p>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{t("home.filter.totalRules", { count: ruleRows.length })}</span>
            </div>
            <div className="overflow-hidden rounded-[20px] border border-zinc-200/80 dark:border-white/10">
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-zinc-100/80 text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
                    <tr>
                      <th className="px-4 py-3 font-medium">{t("home.filter.table.source")}</th>
                      <th className="px-4 py-3 font-medium">{t("home.filter.table.pattern")}</th>
                      <th className="px-4 py-3 font-medium">{t("home.filter.table.mode")}</th>
                      <th className="px-4 py-3 font-medium">{t("home.filter.table.type")}</th>
                      <th className="px-4 py-3 font-medium">{t("home.filter.table.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ruleRows.length ? (
                      ruleRows.map((row) => (
                        <tr key={row.id} className="border-t border-zinc-200/80 bg-white/80 align-top dark:border-white/10 dark:bg-transparent">
                          <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">{t(`home.filter.sources.${row.source}`)}</td>
                          <td className="px-4 py-3 font-mono text-xs text-zinc-800 dark:text-zinc-100">{row.pattern.pattern}</td>
                          <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">{t(`home.filter.modes.${value.mode}.short`)}</td>
                          <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">{t(`home.filter.patternTypes.${row.pattern.type}`)}</td>
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => handleDeleteRow(row)}
                              className="text-sm font-medium text-rose-500 transition hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {t("home.filter.remove")}
                            </button>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                          {t("home.filter.emptyRules")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
