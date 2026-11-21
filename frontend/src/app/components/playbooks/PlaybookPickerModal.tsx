"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { SearchBar } from "@/app/components/ui/search-bar";
import {
  LIQUID_GLASS_HOVER_CLASS,
  LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
  LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS,
} from "@/app/components/ui/liquid-surface";
import { useDocumentWorkspace } from "@/app/contexts/WorkspaceContext";
import { useWorkspaceIdentity } from "@/app/hooks/useWorkspaceIdentity";
import { listPlaybooks, type Playbook } from "@/app/lib/mikeApi";
import { LIQUID_GLASS_SUBTLE_CLASS } from "@mike/ui";

type Props = {
  open: boolean;
  onClose: () => void;
  onSelect: (playbook: Playbook) => void;
  breadcrumbs: ReactNode[];
  initialPlaybookId?: string;
};

function ruleNames(playbook: Playbook) {
  return [
    ...(playbook.content.rules ?? []),
    ...playbook.content.topics.flatMap((topic) => topic.rules),
  ].map((rule) => rule.name || "Untitled rule");
}

/** Picks a playbook to run in chat; laid out like the workflow picker. */
function PlaybookPickerModalForWorkspace({
  open,
  onClose,
  onSelect,
  breadcrumbs,
  initialPlaybookId,
}: Props) {
  const workspace = useDocumentWorkspace();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Playbook | null>(null);
  const [search, setSearch] = useState("");
  const selectedRow = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      setPlaybooks([]);
      setLoading(true);
      setSelected(null);
      setSearch("");
    });
    listPlaybooks(workspace ?? "personal")
      .then((items) => {
        if (cancelled) return;
        setPlaybooks(items);
        if (initialPlaybookId)
          setSelected(items.find((item) => item.id === initialPlaybookId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setPlaybooks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [initialPlaybookId, open, workspace]);

  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  if (!open) return null;

  const query = search.trim().toLowerCase();
  const filtered = query
    ? playbooks.filter((playbook) =>
        [
          playbook.name,
          playbook.description,
          ...playbook.content.documentTypes,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : playbooks;

  function close() {
    setSelected(null);
    setSearch("");
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      size={selected ? "xl" : "lg"}
      breadcrumbs={breadcrumbs}
      primaryAction={{
        label: "Use",
        disabled: !selected,
        onClick: () => {
          if (!selected) return;
          onSelect(selected);
          close();
        },
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-visible md:flex-row">
        <div
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-visible ${
            selected ? "md:w-64 md:flex-none md:shrink-0" : ""
          }`}
        >
          <SearchBar
            value={search}
            onValueChange={setSearch}
            placeholder="Search playbooks..."
          />
          <div
            data-modal-scroll="vertical"
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded-sm pt-2"
          >
            {loading ? (
              <div className="space-y-px">
                {[60, 45, 75, 50, 65].map((width) => (
                  <div
                    key={width}
                    className="flex items-center rounded-md px-3 py-2.5"
                  >
                    <div
                      className="h-3 animate-pulse rounded bg-gray-100"
                      style={{ width: `${width}%` }}
                    />
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-400">
                {query ? "No matches found" : "No playbooks found"}
              </p>
            ) : (
              <div className="space-y-px">
                {filtered.map((playbook) => {
                  const isSelected = selected?.id === playbook.id;
                  return (
                    <button
                      key={playbook.id}
                      ref={isSelected ? selectedRow : null}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setSelected(isSelected ? null : playbook)}
                      className={`flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2 text-left text-xs transition-all ${
                        isSelected
                          ? `${LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS} text-gray-900`
                          : LIQUID_GLASS_MODAL_ROW_HOVER_CLASS
                      }`}
                    >
                      <span
                        className={`min-w-0 flex-1 truncate ${
                          isSelected ? "font-medium text-gray-900" : "text-gray-700"
                        }`}
                      >
                        {playbook.name || "Untitled playbook"}
                      </span>
                      {!selected && playbook.content.documentTypes.length > 0 && (
                        <span className="shrink-0 truncate text-xs text-gray-400">
                          {playbook.content.documentTypes.join(", ")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {selected && (
          <PlaybookPreview
            playbook={selected}
            onClear={() => setSelected(null)}
          />
        )}
      </div>
    </Modal>
  );
}

function PlaybookPreview({
  playbook,
  onClear,
}: {
  playbook: Playbook;
  onClear: () => void;
}) {
  const rules = ruleNames(playbook);
  const facts = [
    { label: "Represented", value: playbook.content.representedParty },
    { label: "Type", value: playbook.content.documentTypes.join(", ") },
    { label: "Jurisdiction", value: playbook.content.jurisdictions.join(", ") },
  ].filter((fact) => fact.value);
  return (
    <section
      aria-label={`${playbook.name || "Untitled playbook"} preview`}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-visible"
    >
      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl p-1 ${LIQUID_GLASS_SUBTLE_CLASS}`}
      >
        <div className="flex h-9 shrink-0 items-center justify-between px-3">
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700">
            {playbook.name || "Untitled playbook"}
          </p>
          <button
            type="button"
            aria-label="Clear selection"
            onClick={onClear}
            className={`rounded-md p-1 text-gray-400 transition-colors hover:text-gray-600 ${LIQUID_GLASS_HOVER_CLASS}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto px-3 py-3 text-xs leading-relaxed text-gray-600">
          {playbook.description && <p>{playbook.description}</p>}
          {facts.length > 0 && (
            <dl className="space-y-1.5">
              {facts.map((fact) => (
                <div key={fact.label} className="flex gap-2">
                  <dt className="w-24 shrink-0 text-gray-400">{fact.label}</dt>
                  <dd className="min-w-0 text-gray-700 [overflow-wrap:anywhere]">
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div>
            <p className="mb-1.5 font-medium text-gray-700">
              {rules.length} {rules.length === 1 ? "rule" : "rules"}
            </p>
            <ul className="list-disc space-y-0.5 pl-4">
              {rules.map((name, index) => (
                <li key={`${name}-${index}`} className="[overflow-wrap:anywhere]">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export function PlaybookPickerModal(props: Props) {
  const identity = useWorkspaceIdentity();
  return <PlaybookPickerModalForWorkspace key={identity} {...props} />;
}
