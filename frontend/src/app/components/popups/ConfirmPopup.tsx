"use client";

import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { PillButton } from "@/app/components/ui/pill-button";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";

type ConfirmStatus = "idle" | "loading" | "complete";

interface ConfirmPopupProps {
  open: boolean;
  title?: ReactNode;
  message?: ReactNode;
  confirmLabel?: ReactNode;
  confirmVariant?: "default" | "danger";
  confirmStatus?: ConfirmStatus;
  cancelLabel?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmDisabled?: boolean;
  className?: string;
}

export function ConfirmPopup({
  open,
  title,
  message,
  confirmLabel,
  confirmVariant = "default",
  confirmStatus = "idle",
  cancelLabel,
  onConfirm,
  onCancel,
  confirmDisabled = false,
  className,
}: ConfirmPopupProps) {
  const t = useTranslations("popups.confirmar");
  if (!open) return null;
  const confirmBusy = confirmStatus === "loading";
  const resolvedConfirmDisabled = confirmDisabled || confirmStatus !== "idle";
  const isDefaultConfirmLabel = confirmLabel === undefined;
  const normalizedConfirmLabel =
    typeof confirmLabel === "string" ? confirmLabel : "Confirm";
  const isDangerAction = confirmVariant === "danger";
  const resolvedConfirmLabel =
    confirmStatus === "loading" ? (
      isDefaultConfirmLabel ? (
        t("confirmando")
      ) : (
        progressiveLabel(normalizedConfirmLabel)
      )
    ) : confirmStatus === "complete" ? (
      isDefaultConfirmLabel ? (
        t("confirmado")
      ) : (
        completedLabel(normalizedConfirmLabel)
      )
    ) : (
      confirmLabel ?? t("confirmar")
    );
  const resolvedCancelLabel = cancelLabel ?? t("cancelar");

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[230] flex justify-center px-4">
      <div
        className={cn(
          `pointer-events-auto w-[min(92vw,520px)] rounded-2xl px-4 py-3 text-sm ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-2xl`,
          className,
        )}
      >
        {title && (
          <div className="text-sm font-medium text-gray-950 mb-3">{title}</div>
        )}
        {message && (
          <div className={cn("text-xs text-gray-700", title && "mt-1")}>
            {message}
          </div>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <PillButton tone="white" size="sm" onClick={onCancel}>
            {resolvedCancelLabel}
          </PillButton>
          <PillButton
            tone={isDangerAction ? "danger" : "black"}
            size="sm"
            onClick={onConfirm}
            disabled={resolvedConfirmDisabled}
            loading={confirmBusy}
          >
            {isDangerAction && confirmStatus !== "complete" && (
              <Trash2 className="h-3 w-3 shrink-0" />
            )}
            {resolvedConfirmLabel}
          </PillButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function progressiveLabel(label: string) {
  const lower = label.toLowerCase();
  if (lower.endsWith("e")) return `${label.slice(0, -1)}ing...`;
  return `${label}ing...`;
}

function completedLabel(label: string) {
  const lower = label.toLowerCase();
  if (lower.endsWith("e")) return `${label}d`;
  return `${label}ed`;
}
