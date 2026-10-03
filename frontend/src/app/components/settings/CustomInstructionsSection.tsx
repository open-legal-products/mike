"use client";

import { useCallback, useEffect, useState } from "react";
import { MarkdownEditor } from "@/app/components/ui/markdown-editor";
import { MemorySaveStatus } from "@/app/components/memory/MemoryEditorState";
import { useMemoryAutosave } from "@/app/components/memory/useMemoryAutosave";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  getCustomInstructions,
  updateCustomInstructions,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

/** Mirrors CUSTOM_INSTRUCTIONS_MAX_LENGTH in the backend user module. */
export const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 8000;

/**
 * Matches the backend's normalization, so a draft that differs from the saved
 * text only by trailing whitespace is not treated as an unsaved change (the
 * editor tends to append a trailing newline).
 */
function normalizeInstructions(value: string) {
  return value.replace(/\r\n?/g, "\n").trimEnd();
}

export function CustomInstructionsSection() {
  const [persisted, setPersisted] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getCustomInstructions(controller.signal)
      .then((current) => {
        if (controller.signal.aborted) return;
        setPersisted(current.content);
        setDraft(current.content);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [loadVersion]);

  const value = normalizeInstructions(draft);
  const tooLong = value.length > CUSTOM_INSTRUCTIONS_MAX_LENGTH;
  const save = useCallback(
    (content: string) => updateCustomInstructions(content),
    [],
  );
  const autosave = useMemoryAutosave({
    value,
    persistedValue: persisted,
    enabled: !loading && !loadError && !tooLong,
    save,
    getPersistedValue: (result) => result.content,
    onSaved: (result) => {
      setPersisted(result.content);
      setSaveError(null);
    },
    onError: (cause) => {
      setSaveError(
        userFacingApiError(
          cause,
          "Custom instructions could not be saved. Your draft has been kept.",
        ),
      );
    },
  });

  return (
    <section
      className="space-y-3"
      aria-labelledby="custom-instructions-heading"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <SettingsHeading id="custom-instructions-heading">
          Custom instructions
        </SettingsHeading>
        {!loading && !loadError ? (
          <MemorySaveStatus
            error={saveError}
            status={autosave.status}
            compact
            onRetry={() => {
              setSaveError(null);
              autosave.retry();
            }}
          />
        ) : null}
      </div>
      <SettingsDescription>
        Tell Mike how you would like it to respond in chats.
      </SettingsDescription>

      {loading ? (
        <div
          className="h-64 animate-pulse rounded-2xl bg-app-surface"
          aria-label="Loading custom instructions"
        />
      ) : loadError ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-red-600" role="alert">
            Could not load your custom instructions. Please try again.
          </p>
          <PillButtonUI
            tone="white"
            size="sm"
            onClick={() => {
              setLoading(true);
              setLoadError(false);
              setLoadVersion((current) => current + 1);
            }}
          >
            Retry
          </PillButtonUI>
        </div>
      ) : (
        <>
          <div className="min-h-[16rem]">
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              ariaLabel="Custom instructions"
              className="min-h-[16rem]"
              allowTables={false}
            />
          </div>
          {tooLong ? (
            <p className="text-xs text-red-600" role="alert">
              Custom instructions must be{" "}
              {CUSTOM_INSTRUCTIONS_MAX_LENGTH.toLocaleString()} characters or
              fewer. Shorten them to save your changes.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
