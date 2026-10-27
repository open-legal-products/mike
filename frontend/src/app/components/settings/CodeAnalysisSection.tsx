"use client";

import { useEffect, useRef, useState } from "react";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { useAssignLatest } from "@/app/hooks/useLatestRef";
import {
  getCodeAnalysisSettings,
  updateCodeAnalysisSettings,
  type CodeAnalysisSettings,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";

export function CodeAnalysisSection() {
  const [settings, setSettings] = useState<CodeAnalysisSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const latestRequestRef = useRef(0);
  const retryRef = useRef<((enabled: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getCodeAnalysisSettings(controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setSettings(loaded);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, [loadVersion]);

  const save = async (enabled: boolean) => {
    if (!settings || settings.enabled === enabled) return;
    const previous = settings.enabled;
    const request = ++latestRequestRef.current;
    const settle = (value: boolean) =>
      setSettings((current) =>
        current ? { ...current, enabled: value } : current,
      );
    settle(enabled);
    setSaving(true);
    try {
      const saved = await updateCodeAnalysisSettings(enabled);
      if (request !== latestRequestRef.current) return;
      setSettings(saved);
    } catch (error) {
      if (request !== latestRequestRef.current) return;
      settle(previous);
      notifyError(error, {
        action: enabled ? "turn on code analysis" : "turn off code analysis",
        onRetry: () => void retryRef.current?.(enabled),
      });
    } finally {
      if (request === latestRequestRef.current) setSaving(false);
    }
  };
  useAssignLatest(retryRef, save);

  return (
    <section className="space-y-3" aria-labelledby="code-analysis-heading">
      <SettingsHeading id="code-analysis-heading">Code Analysis</SettingsHeading>
      <GlassCardUI>
        {loadError ? (
          <SettingsRow>
            <p className="text-sm text-red-600" role="alert">
              Could not load your code analysis settings.
            </p>
            <PillButtonUI
              tone="white"
              size="sm"
              onClick={() => {
                setLoadError(false);
                setLoadVersion((current) => current + 1);
              }}
            >
              Retry
            </PillButtonUI>
          </SettingsRow>
        ) : (
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Run Python for data analysis</SettingsLabel>
              <SettingsDescription>
                Let Mike run Python in a sandbox to analyse spreadsheets and
                prepare visuals from your documents.
              </SettingsDescription>
              {settings && !settings.available && (
                <SettingsDescription>
                  Code analysis is turned off on this server.
                </SettingsDescription>
              )}
            </div>
            {settings ? (
              <ToggleSwitchUI
                checked={settings.enabled && settings.available}
                disabled={saving || !settings.available}
                aria-busy={saving}
                aria-label="Run Python for data analysis"
                onCheckedChange={(enabled) => void save(enabled)}
              />
            ) : (
              <SkeletonLine className="h-5 w-9 shrink-0 rounded-full" />
            )}
          </SettingsRow>
        )}
      </GlassCardUI>
    </section>
  );
}
