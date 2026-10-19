"use client";

import { useState } from "react";
import { Users } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { AccessVisibilityField } from "@/app/components/modals/AccessVisibilityField";
import type { ContentVisibility } from "@/app/components/shared/types";
import type { Playbook, PlaybookContent } from "@/app/lib/mikeApi";
import {
  PlaybookDetailsFields,
  playbookDetailsOf,
  samePlaybookDetails,
  trimPlaybookDetails,
  type PlaybookDetails,
} from "./PlaybookDetailsFields";

/**
 * A playbook's editable details. Changes apply when Update is pressed, as in
 * the other details dialogs.
 */
export function PlaybookDetailsModal({
  open,
  playbook,
  content,
  workspaceName,
  onClose,
  onSave,
  onPeople,
}: {
  open: boolean;
  playbook: Playbook;
  /** The content as edited on the page, which may be ahead of `playbook`. */
  content: PlaybookContent;
  /** The organization's name, or null for a personal playbook. */
  workspaceName: string | null;
  onClose: () => void;
  /** Resolves false when saving failed; the caller has said why. */
  onSave: (
    details: PlaybookDetails,
    visibility: ContentVisibility,
  ) => Promise<boolean>;
  onPeople: () => void;
}) {
  const saved = playbookDetailsOf(content);
  const [details, setDetails] = useState(saved);
  const [visibility, setVisibility] = useState(playbook.visibility);
  const [saving, setSaving] = useState(false);
  const [updated, setUpdated] = useState(false);
  // Each opening starts from the playbook as it is now.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDetails(saved);
      setVisibility(playbook.visibility);
      setUpdated(false);
    }
  }
  const canEdit = playbook.canEdit;
  const isOrganization = !!playbook.orgId;
  const trimmed = trimPlaybookDetails(details);
  const visibilityChanged = visibility !== playbook.visibility;
  const hasChanges =
    !samePlaybookDetails(trimmed, saved) ||
    (isOrganization && visibilityChanged);

  async function save() {
    if (!canEdit || saving || !hasChanges || !trimmed.name) return;
    setSaving(true);
    setUpdated(false);
    try {
      if (await onSave(trimmed, visibility)) {
        setDetails(trimmed);
        setUpdated(true);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      breadcrumbs={["Playbooks", playbook.name || "Untitled playbook", "Details"]}
      secondaryAction={{
        label: "People",
        icon: <Users className="h-4 w-4" />,
        onClick: onPeople,
        disabled: saving,
      }}
      footerStatus={
        updated && !hasChanges ? (
          <span className="text-sm text-gray-400">Updated</span>
        ) : null
      }
      primaryAction={
        canEdit
          ? {
              label: saving ? "Updating…" : "Update",
              onClick: () => void save(),
              disabled: saving || !hasChanges || !trimmed.name,
            }
          : undefined
      }
      cancelAction={canEdit ? undefined : false}
    >
      <div
        data-modal-scroll="vertical"
        className="min-h-0 flex-1 space-y-6 overflow-y-auto pb-4"
      >
        <PlaybookDetailsFields
          value={details}
          onChange={(next) => {
            setDetails(next);
            setUpdated(false);
          }}
          disabled={!canEdit || saving}
        />
        {isOrganization && (
          <AccessVisibilityField
            visibility={visibility}
            onChange={(next) => {
              setVisibility(next);
              setUpdated(false);
            }}
            organizationName={workspaceName}
            resourceNoun="playbook"
            disabled={!playbook.canManageAccess || saving}
          />
        )}
      </div>
    </Modal>
  );
}
