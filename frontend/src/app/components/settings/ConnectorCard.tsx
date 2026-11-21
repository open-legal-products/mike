"use client";

import type { ReactNode } from "react";
import { GlassCardUI } from "@mike/ui";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { SettingsLabel } from "./SettingsText";

/**
 * One settings tile, shared by the connector lists (Installed and Discover)
 * and the model provider lists so they all have the same size and layout:
 * icon, name, and a single trailing control (the on/off switch or the Add
 * button). With `onOpen` the tile opens the Manage dialog.
 */
export function ConnectorCard({
  name,
  detail,
  icon,
  placeholderClassName,
  onOpen,
  action,
  kind = "connector",
}: {
  name: string;
  /** A second line under the name, for a tile with more to say about itself. */
  detail?: ReactNode;
  /** What the tile holds, for its accessible name ("Slack connector"). */
  kind?: string;
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
        <div className="min-w-0 flex-1 break-words text-left">
          <SettingsLabel>{name}</SettingsLabel>
          {detail ? (
            <p className="text-xs break-words text-gray-500">{detail}</p>
          ) : null}
        </div>
      </div>
      {/* The control is its own target; it never opens the Manage dialog.
          Only the control swallows the click, so the space around it still
          opens the tile. Key presses pass through: the tile ignores keys
          that did not start on itself, and Escape must still reach a dialog
          the control just opened. */}
      <div className="ml-auto flex h-9 shrink-0 items-center">
        <div
          className="flex"
          onClick={(event) => event.stopPropagation()}
        >
          {action}
        </div>
      </div>
    </div>
  );
  return (
    <section aria-label={`${name} ${kind}`} className="min-w-0">
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

/**
 * A ConnectorCard while its list loads: the same outer size and layout, so
 * no card appears only to move or vanish once the list is known.
 */
export function ConnectorCardSkeleton() {
  return (
    <div aria-hidden="true" className="min-w-0">
      <GlassCardUI>
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-gray-100" />
          <SkeletonLine className="w-28" />
          <div className="ml-auto h-6 w-11 shrink-0 animate-pulse rounded-full bg-gray-100" />
        </div>
      </GlassCardUI>
    </div>
  );
}
