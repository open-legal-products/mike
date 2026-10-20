"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { AccessVisibilityField } from "@/app/components/modals/AccessVisibilityField";
import type { ContentVisibility } from "@/app/components/shared/types";
import {
  EMPTY_PLAYBOOK_DETAILS,
  PlaybookDetailsFields,
  trimPlaybookDetails,
  type PlaybookDetails,
} from "./PlaybookDetailsFields";

/**
 * Starts a playbook from scratch. Only the name is required; the rest can be
 * filled in later from the playbook's details.
 */
export function NewPlaybookModal({
  open,
  organizationName,
  onClose,
  onCreate,
}: {
  open: boolean;
  /** The organization's name, or null in a personal workspace. */
  organizationName: string | null;
  onClose: () => void;
  /** Resolves false when creating failed; the caller has said why. */
  onCreate: (
    details: PlaybookDetails,
    visibility: ContentVisibility,
  ) => Promise<boolean>;
}) {
  const [details, setDetails] = useState(EMPTY_PLAYBOOK_DETAILS);
  const [visibility, setVisibility] = useState<ContentVisibility>("private");
  const [creating, setCreating] = useState(false);
  // Each opening starts blank.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDetails(EMPTY_PLAYBOOK_DETAILS);
      setVisibility("private");
    }
  }
  const trimmed = trimPlaybookDetails(details);

  async function create() {
    if (!trimmed.name || creating) return;
    setCreating(true);
    try {
      await onCreate(trimmed, visibility);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!creating) onClose();
      }}
      breadcrumbs={["Playbooks", "New playbook"]}
      primaryAction={{
        label: creating ? "Creating…" : "Create",
        icon: creating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : undefined,
        onClick: () => void create(),
        disabled: !trimmed.name || creating,
      }}
      cancelAction={{ label: "Cancel", onClick: onClose, disabled: creating }}
    >
      <form
        data-modal-scroll="vertical"
        className="min-h-0 flex-1 space-y-6 overflow-y-auto pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <PlaybookDetailsFields
          value={details}
          onChange={setDetails}
          disabled={creating}
          autoFocus
        />
        {organizationName !== null && (
          <AccessVisibilityField
            visibility={visibility}
            onChange={setVisibility}
            organizationName={organizationName}
            resourceNoun="playbook"
            disabled={creating}
          />
        )}
      </form>
    </Modal>
  );
}
