"use client";

import { useRef, useState } from "react";
import { Upload, User, X } from "lucide-react";
import {
    addDocumentToProject,
    createProject,
    uploadProjectDocuments,
} from "@/app/lib/mikeApi";
import { FileDirectory } from "../shared/FileDirectory";
import { AddUserInput } from "../shared/AddUserInput";
import type { Document, Project } from "../shared/types";
import type { UserLookupResult } from "@/app/lib/mikeApi";
import { useAuth } from "@/app/contexts/AuthContext";
import { Modal } from "../modals/Modal";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { ProjectPracticeField } from "./ProjectPracticeField";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { LIQUID_GLASS_MODAL_ROW_HOVER_CLASS } from "@/shared/ui/LiquidGlassUI";

interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (project: Project) => void;
}

export function NewProjectModal({ open, onClose, onCreated }: Props) {
    const [step, setStep] = useState<"details" | "documents">("details");
    const [name, setName] = useState("");
    const [cmNumber, setCmNumber] = useState("");
    const [practice, setPractice] = useState("");
    const [sharedUsers, setSharedUsers] = useState<UserLookupResult[]>([]);
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { user } = useAuth();
    const ownEmail = user?.email?.trim().toLowerCase() ?? null;
    const formId = "new-project-modal-form";

    if (!open) return null;

    function submitterValue(e: React.FormEvent<HTMLFormElement>) {
        return (
            (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
        )?.value;
    }

    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (!files.length) return;
        setPendingFiles((prev) => [
            ...prev,
            ...files.filter((f) => !prev.some((p) => p.name === f.name)),
        ]);
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!name.trim()) return;
        if (step === "details" || submitterValue(e) !== "create-project") {
            setStep("documents");
            return;
        }
        setLoading(true);
        setError("");
        try {
            const project = await createProject(
                name.trim(),
                cmNumber.trim() || undefined,
                practice.trim() && practice.trim() !== "Other"
                    ? practice.trim()
                    : undefined,
                ownEmail
                    ? sharedUsers
                          .map((user) => user.email)
                          .filter((email) => email !== ownEmail)
                    : sharedUsers.map((user) => user.email),
            );
            await Promise.all(
                selectedDocuments.map((document) =>
                    addDocumentToProject(project.id, document.id).catch(
                        () => {},
                    ),
                ),
            );
            if (pendingFiles.length > 0) {
                await uploadProjectDocuments(
                    project.id,
                    pendingFiles.map((file) => ({ file })),
                ).catch(() => []);
            }
            onCreated({
                ...project,
                document_count: selectedDocuments.length + pendingFiles.length,
            });
            resetForm();
            onClose();
        } catch (err: unknown) {
            setError(userFacingApiError(err, "Failed to create project"));
        } finally {
            setLoading(false);
        }
    }

    function resetForm() {
        setStep("details");
        setName("");
        setCmNumber("");
        setPractice("");
        setSharedUsers([]);
        setSelectedDocuments([]);
        setPendingFiles([]);
        setError("");
    }

    function handleClose() {
        resetForm();
        onClose();
    }

    function validateShareUser(email: string) {
        if (ownEmail && email === ownEmail) {
            return "You cannot share a project with yourself.";
        }
        if (
            sharedUsers.some(
                (user) => user.email.trim().toLowerCase() === email,
            )
        ) {
            return `${email} already has access.`;
        }
        return null;
    }

    function handleAddShareUser(user: UserLookupResult) {
        setSharedUsers((prev) => [
            ...prev,
            {
                ...user,
                email: user.email.trim().toLowerCase(),
            },
        ]);
    }

    function handleRemoveShareUser(email: string) {
        setSharedUsers((prev) =>
            prev.filter(
                (user) =>
                    user.email.trim().toLowerCase() !==
                    email.trim().toLowerCase(),
            ),
        );
    }

    return (
        <Modal
            open={open}
            onClose={handleClose}
            breadcrumbs={[
                "Projects",
                "New project",
                step === "details" ? "Details" : "Add Documents",
            ]}
            secondaryAction={
                step === "documents"
                    ? {
                          label: `Upload${pendingFiles.length > 0 ? ` (${pendingFiles.length})` : ""}`,
                          icon: <Upload className="h-3.5 w-3.5" />,
                          onClick: () => fileInputRef.current?.click(),
                          disabled: loading,
                      }
                    : undefined
            }
            cancelAction={
                step === "documents"
                    ? {
                          label: "Back",
                          onClick: () => setStep("details"),
                          disabled: loading,
                      }
                    : undefined
            }
            primaryAction={
                step === "details"
                    ? {
                          label: "Next",
                          type: "button",
                          onClick: (event) => {
                              event.preventDefault();
                              setStep("documents");
                          },
                          disabled: !name.trim() || loading,
                      }
                    : {
                          label: loading ? "Creating…" : "Create project",
                          type: "submit",
                          form: formId,
                          name: "modalAction",
                          value: "create-project",
                          disabled: !name.trim() || loading,
                      }
            }
        >
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
            />
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="flex flex-col flex-1 min-h-0"
            >
                {step === "details" ? (
                    <div className="space-y-6">
                        <div>
                            <FieldLabel htmlFor="new-project-name">
                                Project name
                            </FieldLabel>
                            <FormTextInput
                                id="new-project-name"
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Add project name"
                                variant="minimal"
                                autoFocus
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="new-project-cm-number">
                                CM number
                            </FieldLabel>
                            <FormTextInput
                                id="new-project-cm-number"
                                type="text"
                                value={cmNumber}
                                onChange={(e) => setCmNumber(e.target.value)}
                                placeholder="Add a CM number..."
                                variant="minimal"
                                className="text-xl text-gray-600"
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="new-project-practice">
                                Practice
                            </FieldLabel>
                            <ProjectPracticeField
                                id="new-project-practice"
                                value={practice}
                                onChange={setPractice}
                            />
                        </div>

                        <div className="space-y-2">
                            <FieldLabel as="p">Share with</FieldLabel>
                            <AddUserInput
                                onAdd={handleAddShareUser}
                                validateEmail={validateShareUser}
                                placeholder="Add colleagues by email..."
                            />
                            {sharedUsers.length > 0 && (
                                <ul className="space-y-1 pt-1">
                                    {sharedUsers.map((entry) => {
                                        const displayName =
                                            entry.display_name?.trim();
                                        const primary = displayName || "User";
                                        const initial = displayName
                                            ?.charAt(0)
                                            .toUpperCase();
                                        return (
                                            <li
                                                key={entry.email}
                                                className={`${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS} flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors`}
                                            >
                                                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/80 bg-white text-gray-700 shadow-[0_4px_12px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.92),inset_0_-1px_0_rgba(255,255,255,0.64)]">
                                                    {initial ? (
                                                        <span className="font-serif text-[11px] leading-none">
                                                            {initial}
                                                        </span>
                                                    ) : (
                                                        <User className="h-2.5 w-2.5" />
                                                    )}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate text-xs text-gray-800">
                                                        {primary}
                                                        <span className="text-gray-400">
                                                            {" "}
                                                            · {entry.email}
                                                        </span>
                                                    </p>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        handleRemoveShareUser(
                                                            entry.email,
                                                        )
                                                    }
                                                    className="self-center inline-flex items-center rounded-full px-2 py-1 text-xs text-gray-500 transition-colors hover:text-red-600"
                                                    aria-label={`Remove ${entry.email}`}
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <FileDirectory
                            selectedDocuments={selectedDocuments}
                            onChange={setSelectedDocuments}
                            showTabs
                        />
                    </div>
                )}

                {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
            </form>
        </Modal>
    );
}
