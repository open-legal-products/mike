"use client";

import { useId, type ReactNode } from "react";
import { AccessScopeLabel } from "@/app/components/shared/AccessScopeLabel";
import { CreatorLabel } from "@/app/components/shared/CreatorLabel";
import { EDITOR_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import type { Playbook } from "@/app/lib/mikeApi";
import { modelDisplayName } from "@/shared/lib/modelCatalog";
import { PlaybookPanels } from "./PlaybookPanels";
import {
  PLAYBOOK_PANE_BODY_CLASS,
  PLAYBOOK_PANE_HEADER_CLASS,
} from "./playbookPaneStyles";
import { accessScope } from "./PlaybookTable";

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * The playbook's overview: read-only facts about it on the left, and the
 * editable details, passed as children, on the right.
 */
export function PlaybookOverview({
  playbook,
  ruleCount,
  workspaceName,
  children,
}: {
  playbook: Playbook;
  ruleCount: number;
  /** The organization's name, or null for a personal playbook. */
  workspaceName: string | null;
  children: ReactNode;
}) {
  const headingId = useId();
  const facts: { label: string; value: ReactNode }[] = [
    {
      label: "Creator",
      value: (
        <CreatorLabel
          label={
            playbook.isCreator
              ? "Me"
              : playbook.creatorName?.trim() || "Unknown"
          }
          photo={playbook.creatorPhoto}
          name={playbook.creatorName}
        />
      ),
    },
    {
      label: "Created",
      value: (
        <time dateTime={playbook.createdAt}>
          {formatDateTime(playbook.createdAt)}
        </time>
      ),
    },
    {
      label: "Updated",
      value: (
        <time dateTime={playbook.updatedAt}>
          {formatDateTime(playbook.updatedAt)}
        </time>
      ),
    },
    {
      label: "Workspace",
      value: playbook.orgId ? workspaceName || "Organization" : "Personal",
    },
    {
      label: "Access",
      value: (
        <AccessScopeLabel
          scope={accessScope(playbook)}
          organizationName={workspaceName}
          directGrantCount={
            playbook.canManageAccess ? playbook.sharedWith.length : undefined
          }
        />
      ),
    },
    {
      label: "Source",
      value: playbook.sourceFilename || "Created in Mike",
    },
    ...(playbook.importModel
      ? [
          {
            label: "Compiled with",
            value: modelDisplayName(playbook.importModel),
          },
        ]
      : []),
    { label: "Rules", value: ruleCount },
  ];

  return (
    <PlaybookPanels
      sidebar={
        <section
          aria-label="Playbook information"
          className={`flex min-h-0 min-w-0 flex-col ${EDITOR_SURFACE_CLASS}`}
        >
          <div className={`flex items-center ${PLAYBOOK_PANE_HEADER_CLASS}`}>
            <h2 className="text-sm font-medium text-gray-900">Details</h2>
          </div>
          <dl className={`min-h-0 space-y-3 overflow-y-auto ${PLAYBOOK_PANE_BODY_CLASS}`}>
            {facts.map((fact) => (
              <div key={fact.label} className="min-w-0">
                <dt className="text-xs text-gray-500">{fact.label}</dt>
                <dd className="mt-0.5 text-sm text-gray-900 [overflow-wrap:anywhere]">
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      }
    >
      <section
        aria-labelledby={headingId}
        className={`@container flex min-h-0 min-w-0 flex-col overflow-hidden ${EDITOR_SURFACE_CLASS}`}
      >
        <div className={PLAYBOOK_PANE_HEADER_CLASS}>
          <h2 id={headingId} className="text-sm font-medium text-gray-900">
            Overview
          </h2>
        </div>
        <div className={`min-h-0 flex-1 space-y-6 overflow-y-auto ${PLAYBOOK_PANE_BODY_CLASS}`}>
          {children}
        </div>
      </section>
    </PlaybookPanels>
  );
}
