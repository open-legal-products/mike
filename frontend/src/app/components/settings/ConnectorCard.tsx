"use client";

import type { ReactNode } from "react";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsLabel } from "./SettingsText";

/**
 * One connector tile, shared by Installed and Discover so both lists have the
 * same size and layout: icon, name, and a single trailing control (the on/off
 * switch or the Add button). With `onOpen` the tile opens the Manage dialog.
 */
export function ConnectorCard({
  name,
  icon,
  placeholderClassName,
  onOpen,
  action,
}: {
  name: string;
  /** Brand icon; without one a small coloured shape is shown. */
  icon?: ReactNode;
  placeholderClassName?: string;
  onOpen?: () => void;
  action: ReactNode;
}) {
  const body = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-0 flex-[1_0_8rem] items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-transparent">
          {icon ?? (
            <span
              data-connector-placeholder
              aria-hidden="true"
              className={placeholderClassName ?? "h-5 w-5 rounded-full bg-violet-400"}
            />
          )}
        </div>
        <div className="min-w-0 flex-1 text-left">
          <SettingsLabel>{name}</SettingsLabel>
        </div>
      </div>
      {/* The control is its own target; it never opens the Manage dialog. */}
      <div
        className="ml-auto flex h-9 shrink-0 items-center"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {action}
      </div>
    </div>
  );
  return (
    <section aria-label={`${name} connector`} className="min-w-0">
      <GlassCardUI>
        {onOpen ? (
          <div
            className="cursor-pointer rounded-xl px-4 py-3 transition-colors hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            role="button"
            tabIndex={0}
            aria-label={`Manage ${name}`}
            onClick={onOpen}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
              }
            }}
          >
            {body}
          </div>
        ) : (
          <div className="px-4 py-3">{body}</div>
        )}
      </GlassCardUI>
    </section>
  );
}
