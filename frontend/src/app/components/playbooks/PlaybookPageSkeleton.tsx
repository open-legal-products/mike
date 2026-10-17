"use client";

import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { EDITOR_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import {
  PLAYBOOK_PANE_BODY_CLASS,
  PLAYBOOK_PANE_HEADER_CLASS,
  PLAYBOOK_PANE_INSET_CLASS,
  PLAYBOOK_PANE_LIST_CLASS,
} from "./playbookPaneStyles";

function PillSkeleton({ className }: { className: string }) {
  return (
    <span
      className={`h-7 shrink-0 rounded-full bg-gray-100 animate-pulse ${className}`}
    />
  );
}

/**
 * Shown while a playbook opened by its link is loading, so a refreshed
 * playbook page does not flash the playbooks table. It matches the Rules view:
 * the toolbar, the rule list, and the rule editor.
 */
export function PlaybookPageSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading playbook"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0">
        <TableToolbar
          leading={
            <div className="flex w-full items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <PillSkeleton className="w-20" />
                <PillSkeleton className="w-14" />
                <PillSkeleton className="w-24" />
                <PillSkeleton className="w-14" />
              </div>
              <PillSkeleton className="w-24" />
            </div>
          }
        />
      </div>
      <div className="@container flex min-h-0 flex-1 flex-col">
        <div className="mx-3 mb-3 grid min-h-0 flex-1 grid-cols-1 gap-1.5 p-0.5 md:mx-6.5 @[48rem]:grid-cols-[320px_minmax(0,1fr)]">
          <section
            className={`flex min-h-0 min-w-0 flex-col ${EDITOR_SURFACE_CLASS}`}
          >
            <div className={`flex items-center ${PLAYBOOK_PANE_HEADER_CLASS}`}>
              <div className="flex h-5 items-center">
                <SkeletonLine className="w-12" />
              </div>
            </div>
            <div className={`space-y-1 ${PLAYBOOK_PANE_LIST_CLASS}`}>
              {["w-3/4", "w-1/2", "w-2/3", "w-3/5"].map((width) => (
                <div key={width} className="flex h-7 items-center px-2">
                  <SkeletonLine className={width} />
                </div>
              ))}
            </div>
          </section>
          <section
            className={`flex min-h-[24rem] min-w-0 flex-col overflow-hidden @[48rem]:min-h-0 ${EDITOR_SURFACE_CLASS}`}
          >
            <div className={PLAYBOOK_PANE_HEADER_CLASS}>
              <div className="flex h-5 items-center">
                <SkeletonLine className="w-10" />
              </div>
              <div className="mt-1 h-8 w-2/5 rounded-md bg-gray-100 animate-pulse" />
            </div>
            <div className={`flex flex-wrap gap-1.5 pb-2 ${PLAYBOOK_PANE_INSET_CLASS}`}>
              <PillSkeleton className="w-20" />
              <PillSkeleton className="w-20" />
              <PillSkeleton className="w-24" />
            </div>
            <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto ${PLAYBOOK_PANE_BODY_CLASS}`}>
              {[0, 1].map((index) => (
                <div key={index} className="space-y-2">
                  <SkeletonLine className="w-24" />
                  <div className="h-20 rounded-lg bg-gray-100 animate-pulse" />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
