"use client";

import { useState } from "react";
import { Modal } from "./Modal";
import { FieldLabel, FormTextInput } from "../ui/form-field";

interface RenameModalProps {
    open: boolean;
    /** Breadcrumb trail, e.g. ["Assistant", "Rename Chat"]. */
    breadcrumbs: string[];
    initialValue: string;
    label?: string;
    saving?: boolean;
    onClose: () => void;
    onSave: (value: string) => void;
}

export function RenameModal(props: RenameModalProps) {
    // Mount the form only while open so the draft restarts from the current
    // name each time, without syncing state in an effect.
    return props.open ? <RenameModalForm {...props} /> : null;
}

function RenameModalForm({
    open,
    breadcrumbs,
    initialValue,
    label = "Name",
    saving = false,
    onClose,
    onSave,
}: RenameModalProps) {
    const [draft, setDraft] = useState(initialValue);
    const formId = "rename-modal-form";
    const trimmed = draft.trim();

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="sm"
            className="h-auto"
            breadcrumbs={breadcrumbs}
            cancelAction={{ label: "Cancel", onClick: onClose, disabled: saving }}
            primaryAction={{
                label: saving ? "Saving..." : "Save",
                type: "submit",
                form: formId,
                disabled: !trimmed || saving,
            }}
        >
            <form
                id={formId}
                onSubmit={(event) => {
                    event.preventDefault();
                    if (trimmed && !saving) onSave(trimmed);
                }}
            >
                <FieldLabel htmlFor="rename-modal-input">{label}</FieldLabel>
                <FormTextInput
                    id="rename-modal-input"
                    type="text"
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                />
            </form>
        </Modal>
    );
}
