import React, { useEffect, useMemo, useState } from "react";
import type { Playbook } from "../../types";
import { listPlaybooks } from "../../api/mikeApi";
import { Modal } from "../primitives/Modal";
import { PickerList } from "../primitives/PickerList";
import { userMessage } from "../../lib/notify";

/** What a playbook is called in the picker and on its pill. */
export function playbookTitle(playbook: Pick<Playbook, "name">): string {
  return playbook.name.trim() || "Untitled playbook";
}

interface PlaybookModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (playbook: Playbook) => void;
  initialPlaybookId?: string;
}

/**
 * Picks a playbook to run on the next message, laid out like the workflow
 * picker (WorkflowModal) and listing what the web picker lists: the
 * Personal playbooks the user can open.
 */
export function PlaybookModal({
  open,
  onClose,
  onSelect,
  initialPlaybookId,
}: PlaybookModalProps): React.ReactElement | null {
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [selectedId, setSelectedId] = useState(initialPlaybookId ?? "");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSearch("");
    setSelectedId(initialPlaybookId ?? "");
    listPlaybooks()
      .then((items) => {
        if (!cancelled) setPlaybooks(items ?? []);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setPlaybooks([]);
        setError(
          userMessage(reason, {
            fallback: "Mike couldn't load your playbooks. Try again.",
            operation: "playbooks.review",
          }),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialPlaybookId, open]);

  const items = useMemo(
    () =>
      playbooks.map((playbook) => ({
        id: playbook.id,
        title: playbookTitle(playbook),
        meta: playbook.content.documentTypes.join(", "),
        searchText: [
          playbook.name,
          playbook.description,
          ...playbook.content.documentTypes,
        ].join(" "),
      })),
    [playbooks],
  );
  const selected = playbooks.find((playbook) => playbook.id === selectedId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add playbook"
      primaryAction={{
        label: "Use",
        disabled: !selected,
        onClick: () => {
          if (!selected) return;
          onSelect(selected);
          onClose();
        },
      }}
    >
      <PickerList
        items={items}
        search={search}
        onSearchChange={setSearch}
        loading={loading}
        error={error}
        selectedId={selectedId}
        searchPlaceholder="Search playbooks..."
        loadingLabel="Loading playbooks…"
        emptyMessage="No playbooks found"
        onSelect={(id) => setSelectedId(id === selectedId ? "" : id)}
      />
    </Modal>
  );
}
