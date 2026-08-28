"use client";

import { useRef, useState } from "react";
import { Upload, User, X } from "lucide-react";
import {
    UploadBatchError,
    addDocumentToProject,
    createProject,
    failedUploadMessage,
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
    // A project created with only some of its files attached. The modal holds
    // it until the user has read which files are missing.
    const [pendingProject, setPendingProject] = useState<Project | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // The project is created before its documents are attached. Remember it so
    // a retry after an attachment failure reuses the project the user already
    // has instead of creating a second one.
    const createdProjectRef = useRef<Project | null>(null);
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

    function finishCreation(project: Project) {
        onCreated(project);
        resetForm();
        onClose();
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!name.trim()) return;
        if (pendingProject) {
            finishCreation(pendingProject);
            return;
        }
        if (step === "details" || submitterValue(e) !== "create-project") {
            setStep("documents");
            return;
        }
        setLoading(true);
        setError("");
        try {
            const project =
                createdProjectRef.current ??
                (await createProject(
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
                ));
            createdProjectRef.current = project;

            const linkResults = await Promise.all(
                selectedDocuments.map((document) =>
                    addDocumentToProject(project.id, document.id).then(
                        () => true,
                        () => false,
                    ),
                ),
            );
            const linkedCount = linkResults.filter(Boolean).length;
            const failedLinkNames = selectedDocuments
                .filter((_, index) => !linkResults[index])
                .map((document) => document.filename);

            let uploadedCount = 0;
            let uploadFailure: string | null = null;
            if (pendingFiles.length > 0) {
                try {
                    const outcomes = await uploadProjectDocuments(
                        project.id,
                        pendingFiles.map((file) => ({ file })),
                    );
                    uploadedCount = outcomes.filter(
                        (outcome) => outcome.status === "completed",
                    ).length;
                    if (uploadedCount < outcomes.length) {
                        uploadFailure = failedUploadMessage(outcomes);
                    }
                } catch (uploadError) {
                    // Aborts, session-creation failures, and batch validation
                    // still throw; everything else comes back as outcomes.
                    uploadFailure =
                        uploadError instanceof UploadBatchError
                            ? failedUploadMessage(uploadError.outcomes)
                            : userFacingApiError(
                                  uploadError,
                                  "The attached files could not be uploaded. Please try again.",
                              );
                }
            }

            const attachedCount = linkedCount + uploadedCount;
            const requestedCount =
                selectedDocuments.length + pendingFiles.length;
            const failureMessage = [
                uploadFailure,
                failedLinkNames.length > 0
                    ? `${failedLinkNames.join(", ")} could not be added to the project.`
                    : null,
            ]
                .filter(Boolean)
                .join(" ");

            if (failureMessage) {
                setError(failureMessage);
                // Nothing the user attached made it in: stay put so the primary
                // action retries the attachments against the same project,
                // instead of closing on a project with no documents.
                if (attachedCount === 0 && requestedCount > 0) return;
                // Partial success: the project is real, so let the user read
                // which files are missing before the modal hands it over.
                setPendingProject({ ...project, document_count: attachedCount });
                return;
            }

            finishCreation({ ...project, document_count: attachedCount });
        } catch (err: unknown) {
            setError(userFacingApiError(err, "Failed to create project"));
        } finally {
            setLoading(false);
        }
    }

    function resetForm() {
        createdProjectRef.current = null;
        setPendingProject(null);
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
        // The project is created before its documents are attached, so a close
        // after an attachment failure must still hand the project over. Losing
        // it here would leave a real project missing from the list.
        const created = pendingProject ?? createdProjectRef.current;
        if (created) {
            finishCreation({ ...created, document_count: created.document_count ?? 0 });
            return;
        }
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
                          label: loading
                              ? "Creating…"
                              : pendingProject
                                ? "Continue"
                                : "Create project",
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
