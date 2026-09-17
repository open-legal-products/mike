"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  ModalUI,
  type ModalUISize,
} from "@/shared/ui/ModalUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { cn } from "@/app/lib/utils";

type ModalAction = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className"
> & {
  label: ReactNode;
  icon?: ReactNode;
  variant?: "primary" | "secondary" | "blue" | "danger";
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  breadcrumbs?: ReactNode[];
  headerAction?: ReactNode;
  size?: ModalUISize;
  className?: string;
  footerStatus?: ReactNode;
  primaryAction?: ModalAction;
  secondaryAction?: ModalAction;
  cancelAction?: ModalAction | false;
  /**
   * Keep the modal (and its children's state) mounted while closed,
   * rendering it hidden instead of unmounting. Lets content like loaded
   * directory listings survive close/reopen cycles.
   */
  keepMounted?: boolean;
}

export function Modal({
  open,
  onClose,
  children,
  breadcrumbs,
  headerAction,
  size = "lg",
  className,
  footerStatus,
  primaryAction,
  secondaryAction,
  cancelAction,
  keepMounted = false,
}: ModalProps) {
  const lastBreadcrumb = breadcrumbs?.at(-1);

  return (
    <ModalUI
      open={open}
      onClose={onClose}
      breadcrumbs={breadcrumbs}
      headerAction={headerAction}
      size={size}
      className={cn("h-[min(600px,calc(100vh-2rem))]", className)}
      ariaLabel={
        typeof lastBreadcrumb === "string" ? lastBreadcrumb : undefined
      }
      footerStatus={footerStatus}
      secondaryAction={
        secondaryAction ? (
          <ModalActionButton
            action={secondaryAction}
            fallbackVariant="secondary"
          />
        ) : undefined
      }
      cancelAction={
        cancelAction ? (
          <ModalActionButton action={cancelAction} fallbackVariant="cancel" />
        ) : undefined
      }
      primaryAction={
        primaryAction ? (
          <ModalActionButton action={primaryAction} fallbackVariant="primary" />
        ) : undefined
      }
      keepMounted={keepMounted}
    >
      {children}
    </ModalUI>
  );
}

function ModalActionButton({
  action,
  fallbackVariant,
}: {
  action: ModalAction;
  fallbackVariant: "primary" | "secondary" | "danger" | "cancel";
}) {
  const {
    label,
    icon,
    variant = fallbackVariant === "cancel" ? "secondary" : fallbackVariant,
    ...props
  } = action;

  if (fallbackVariant === "cancel") {
    return (
      <button
        type="button"
        className="px-2 py-1.5 text-sm text-gray-500 transition-colors hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
        {...props}
      >
        {label}
      </button>
    );
  }

  const tone =
    variant === "danger"
      ? "danger"
      : variant === "blue"
        ? "blue"
        : fallbackVariant === "secondary" && variant === "secondary"
          ? "blue"
          : variant === "primary"
            ? "black"
            : "white";

  return (
    <PillButtonUI tone={tone} size="normal" {...props}>
      {icon}
      {label}
    </PillButtonUI>
  );
}
