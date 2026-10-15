"use client";

import { useDocumentWorkspace } from "@/app/contexts/WorkspaceContext";
import { useWorkspaceIdentity } from "@/app/hooks/useWorkspaceIdentity";

import { useEffect, useState, type ReactNode } from "react";
import { listWorkflows } from "@/app/lib/mikeApi";
import { Modal } from "../modals/Modal";
import type { Workflow } from "../shared/types";
import { WorkflowPickerContent } from "./WorkflowPickerContent";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

interface WorkflowPickerModalProps {
    open: boolean;
    onClose: () => void;
    onSelect: (workflow: Workflow) => Promise<void> | void;
    workflowType: Workflow["metadata"]["type"];
    breadcrumbs: ReactNode[];
    primaryLabel?: string;
    selectingLabel?: string;
    selecting?: boolean;
    closeOnSelect?: boolean;
    initialWorkflowId?: string;
    disabledWorkflow?: (workflow: Workflow) => boolean;
}

function WorkflowPickerModalForWorkspace({
    open,
    onClose,
    onSelect,
    workflowType,
    breadcrumbs,
    primaryLabel = "Use",
    selectingLabel,
    selecting = false,
    closeOnSelect = true,
    initialWorkflowId,
    disabledWorkflow,
}: WorkflowPickerModalProps) {
    const workspace = useDocumentWorkspace();
    const [workflows, setWorkflows] = useState<Workflow[]>([]);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<Workflow | null>(null);
    const [search, setSearch] = useState("");

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const frame = requestAnimationFrame(() => {
            if (cancelled) return;
            setWorkflows([]);
            setLoading(true);
            setSelected(null);
            setSearch("");
        });

        listWorkflows(workflowType, workspace ?? "personal")
            .then((workflows) => {
                if (cancelled) return;
                devLog("[workflows/ui:picker] loaded", {
                    workflowType,
                    workflowCount: workflows.length,
                    systemCount: workflows.filter((workflow) => workflow.is_system)
                        .length,
                    sample: workflows.slice(0, 5).map((workflow) => ({
                        id: workflow.id,
                        title: workflow.metadata.title,
                        type: workflow.metadata.type,
                        user_id: workflow.user_id,
                        is_system: workflow.is_system,
                        is_owner: workflow.is_owner,
                    })),
                });
                setWorkflows(workflows);
                if (initialWorkflowId) {
                    setSelected(
                        workflows.find(
                            (workflow) => workflow.id === initialWorkflowId,
                        ) ?? null,
                    );
                }
            })
            .catch((error) => {
                if (cancelled) return;
                devLog("[workflows/ui:picker] failed", {
                    workflowType,
                    error,
                });
                setWorkflows([]);
                setSelected(null);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
            cancelAnimationFrame(frame);
        };
    }, [initialWorkflowId, open, workflowType, workspace]);

    if (!open) return null;

    const selectionDisabled =
        !selected || selecting || (selected && disabledWorkflow?.(selected));
    const resolvedPrimaryLabel =
        selecting && selectingLabel ? selectingLabel : primaryLabel;

    function handleClose() {
        setSelected(null);
        setSearch("");
        onClose();
    }

    async function handleSelect() {
        if (!selected || selectionDisabled) return;
        await onSelect(selected);
        if (closeOnSelect) handleClose();
    }

    return (
        <Modal
            open={open}
            onClose={handleClose}
            size={selected ? "xl" : "lg"}
            breadcrumbs={breadcrumbs}
            primaryAction={{
                label: resolvedPrimaryLabel,
                onClick: () => void handleSelect(),
                disabled: selectionDisabled,
            }}
        >
            <WorkflowPickerContent
                workflows={workflows}
                selected={selected}
                onSelect={setSelected}
                search={search}
                onSearchChange={setSearch}
                loading={loading}
                previewLoading={loading}
                workflowType={workflowType}
                previewMode={workflowType === "tabular" ? "columns" : "prompt"}
                disabledWorkflow={disabledWorkflow}
            />
        </Modal>
    );
}

export function WorkflowPickerModal(props: WorkflowPickerModalProps) {
    const identity = useWorkspaceIdentity();
    return <WorkflowPickerModalForWorkspace key={identity} {...props} />;
}
