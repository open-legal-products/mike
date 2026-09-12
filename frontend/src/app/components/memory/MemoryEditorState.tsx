"use client";

import { useTranslations } from "next-intl";
import { PillButton } from "@/app/components/ui/pill-button";
import type { MemoryAutosaveStatus } from "./useMemoryAutosave";
import type { MemoryCurrent } from "@/app/lib/mikeApi";

export function memoryActivityLabel(memory: MemoryCurrent) {
  if (memory.status === "scheduled") return "Memory review scheduled";
  if (memory.status === "processing") return "Updating memory…";
  return null;
}

export function useMemoryActivityLabel(memory: MemoryCurrent | null) {
  const t = useTranslations("memoria");
  if (!memory) return null;
  if (memory.status === "scheduled") return t("revisaoAgendada");
  if (memory.status === "processing") return t("atualizandoMemoria");
  return null;
}

export function MemoryConflictNotice({
  project = false,
  onReload,
  onKeepDraft,
}: {
  project?: boolean;
  onReload: () => void;
  onKeepDraft: () => void;
}) {
  const t = useTranslations("memoria");
  return (
    <div
      className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
      role="alert"
    >
      <p className="font-medium">
        {t("avisoConflito", { projeto: project ? "true" : "false" })}
      </p>
      <p className="mt-1 text-xs text-amber-800">
        {t("avisoConflitoDescricao")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <PillButton tone="white" size="sm" onClick={onReload}>
          {t("recarregarUltima")}
        </PillButton>
        <PillButton tone="black" size="sm" onClick={onKeepDraft}>
          {t("manterRascunho")}
        </PillButton>
      </div>
    </div>
  );
}

export function MemorySaveStatus({
  error,
  status,
  onRetry,
  compact = false,
}: {
  error: string | null;
  status: MemoryAutosaveStatus;
  onRetry: () => void;
  compact?: boolean;
}) {
  const t = useTranslations("memoria");
  if (error) {
    return (
      <span
        className={`inline-flex items-center gap-2 ${compact ? "text-xs" : "text-sm"}`}
      >
        <span className="text-red-600" role="alert">
          {error}
        </span>
        <button
          type="button"
          className="font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
          onClick={onRetry}
        >
          {t("tentarNovamente")}
        </button>
      </span>
    );
  }
  if (status === "idle") return null;
  return (
    <span className="text-xs text-gray-500" role="status" aria-live="polite">
      {status === "saving" ? t("salvando") : t("salvo")}
    </span>
  );
}
