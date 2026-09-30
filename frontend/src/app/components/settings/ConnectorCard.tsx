"use client";

import type { ReactNode } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { SettingsCard } from "./SettingsCard";
import { SettingsLabel } from "./SettingsText";

/** Shared discovery layout and action states for native and MCP connectors. */
export function ConnectorCard({
  name,
  icon,
  connected,
  loading,
  connecting = false,
  adding = false,
  disabled = false,
  accountEmail,
  summary,
  error,
  notice,
  onAdd,
  onCancel,
  onManage,
}: {
  name: string;
  icon: ReactNode;
  connected: boolean;
  loading: boolean;
  connecting?: boolean;
  adding?: boolean;
  disabled?: boolean;
  accountEmail?: string | null;
  summary: string;
  error?: string | null;
  notice?: ReactNode;
  onAdd?: () => void;
  onCancel?: () => void;
  onManage?: () => void;
}) {
  const label = loading
    ? "Loading…"
    : connecting
      ? "Cancel"
      : adding
        ? "Adding…"
        : connected
          ? onManage
            ? "Manage"
            : "Added"
          : "Add";
  return (
    <section aria-label={`${name} connector`} className="min-w-0">
      <SettingsCard>
        <div className="flex min-h-24 flex-wrap items-center gap-3 p-4">
          <div className="flex min-w-0 flex-[1_0_8rem] items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center">
              {icon}
            </div>
            <div className="min-w-0 flex-1">
              <SettingsLabel>{name}</SettingsLabel>
              {accountEmail && (
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {accountEmail}
                </p>
              )}
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {summary}
              </p>
            </div>
          </div>
          <PillButtonUI
            className="ml-auto"
            tone={connected ? "white" : "blue"}
            size="sm"
            loading={adding && !connecting}
            disabled={
              loading ||
              (!connecting && (disabled || (connected ? !onManage : !onAdd)))
            }
            aria-label={
              connecting ? `Cancel ${name} authorization` : `${label} ${name}`
            }
            onClick={connecting ? onCancel : connected ? onManage : onAdd}
          >
            {label}
          </PillButtonUI>
        </div>
        {connecting && (
          <p role="status" className="px-4 pb-4 text-xs text-muted-foreground">
            Waiting for {name}…
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="px-4 pb-4 text-xs text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        )}
        {notice && (
          <div className="px-4 pb-4 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {notice}
          </div>
        )}
      </SettingsCard>
    </section>
  );
}
