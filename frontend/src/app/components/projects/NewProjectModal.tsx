"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, User, X } from "lucide-react";
import {
    type Org,
    UploadBatchError,
    addDocumentToProject,
    createProject,
    failedUploadMessage,
    grantProjectAccess,
    listOrgs,
    uploadProjectDocuments,
} from "@/app/lib/mikeApi";
import { FileDirectory } from "../shared/FileDirectory";
import { AddUserInput } from "../shared/AddUserInput";
import type { Document, Project } from "../shared/types";
import type { UserLookupResult } from "@/app/lib/mikeApi";
import { useAuth } from "@/app/contexts/AuthContext";
import { Modal } from "../modals/Modal";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { ModalSelect } from "../modals/ModalSelect";
import { ProjectPracticeField } from "./ProjectPracticeField";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
    PROJECT_ROLES,
    PROJECT_ROLE_DESCRIPTIONS,
    PROJECT_ROLE_LABELS,
    isProjectRole,
    type ProjectRole,
} from "@/app/lib/permissions";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/shared/ui/LiquidGlassUI";

const PERSONAL_WORKSPACE = "__personal__";

/** Byte-identical to the share dialog's picker, so the two dialogs match. */
const ROLE_SELECT_CLASS = `h-6 rounded-full px-2 text-xs text-gray-700 ${LIQUID_GLASS_SUBTLE_CLASS} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-50`;

/** A recipient chosen before the project exists, with the role they'll get. */
type PendingRecipient = UserLookupResult & { role: ProjectRole };

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
    const [sharedUsers, setSharedUsers] = useState<PendingRecipient[]>([]);
    const [newRole, setNewRole] = useState<ProjectRole>("member");
    const [orgs, setOrgs] = useState<Org[]>([]);
    const [orgId, setOrgId] = useState<string>(PERSONAL_WORKSPACE);
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    // A project created with only some of its files attached. The modal holds
    // it until the user has read which files are missing.
    const [pendingProject, setPendingProject] = useState<Project | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // The project is created before its grants are written and its documents
    // are attached. Remember it so a retry after either kind of failure
    // reuses the project the user already has instead of creating a second
    // one.
    const createdProjectRef = useRef<Project | null>(null);
    const { user } = useAuth();
    const ownEmail = user?.email?.trim().toLowerCase() ?? null;
    const formId = "new-project-modal-form";

    // Load the caller's organizations so a project can be created inside a
    // firm instead of the caller's private workspace. Every row is a real
    // organization now — there is no hidden personal one to filter out.
    // Best-effort: without orgs the field simply doesn't render.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        listOrgs()
            .then((rows) => {
                if (!cancelled) setOrgs(rows);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [open]);

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
            // Create, then grant. `POST /projects` only accepts the roleless
            // `shared_with` array — every address in it lands at member, and
            // an address with no Mike account is refused outright with 400
            // "<email> does not belong to a Mike user." Sending it here would
            // have thrown away the roles chosen above and rejected exactly
            // the outside-counsel case the review asked for, so the roles go
            // through `POST /projects/:id/access` instead, which keys on
            // email and does not require an existing account.
            const project =
                createdProjectRef.current ??
                (await createProject(
                    name.trim(),
                    cmNumber.trim() || undefined,
                    practice.trim() && practice.trim() !== "Other"
                        ? practice.trim()
                        : undefined,
                    undefined,
                    orgId !== PERSONAL_WORKSPACE ? orgId : undefined,
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


            // Sequential: these are a handful of addresses, and one refusal
            // should be reported with its own message rather than lost in a
            // race. The endpoint upserts, so a retry after a partial failure
            // is safe.
            const recipients = sharedUsers.filter(
                (entry) => !ownEmail || entry.email !== ownEmail,
            );
            const grantFailures: { email: string; detail: string }[] = [];
            for (const entry of recipients) {
                try {
                    await grantProjectAccess(
                        project.id,
                        entry.email,
                        entry.role,
                    );
                } catch (err: unknown) {
                    grantFailures.push({
                        email: entry.email,
                        detail: userFacingApiError(err, "the request failed"),
                    });
                }
            }
            if (grantFailures.length > 0) {
                // The project exists, so say so — and stay open rather than
                // navigating away from the only place that knows the sharing
                // did not happen. Pressing Create again retries the grants
                // against the same project.
                setError(
                    `Project created, but access was not granted to ${grantFailures
                        .map((failure) => failure.email)
                        .join(", ")}: ${grantFailures[0].detail}`,
                );
                // Stay open on THIS dialog: createdProjectRef holds the
                // project, so pressing Create again retries only the grants.
                return;
            }

            // POST /projects returns a bare row with no role fields, and
            // the list's fail-closed roleFrom() reads "no role fields" as
            // viewer — so the creator had no row menu, no Edit details and no
            // Delete on the project they just made until a refetch. This
            // row's standing is not unknown: the caller IS the creator, and a
            // creator derives admin by definition. Same stamp the optimistic
            // chat row gets in ChatHistoryContext, for the same reason.
            const stamped = {
                ...project,
                is_owner: true,
                access_role: "admin" as const,
            };

            if (failureMessage) {
                setError(failureMessage);
                // Nothing the user attached made it in: stay put so the primary
                // action retries the attachments against the same project,
                // instead of closing on a project with no documents.
                if (attachedCount === 0 && requestedCount > 0) return;
                // Partial success: the project is real, so let the user read
                // which files are missing before the modal hands it over.
                setPendingProject({ ...stamped, document_count: attachedCount });
                return;
            }

            finishCreation({ ...stamped, document_count: attachedCount });
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
        setNewRole("member");
        setName("");
        setCmNumber("");
        setPractice("");
        setSharedUsers([]);
        setSelectedDocuments([]);
        setPendingFiles([]);
        setOrgId(PERSONAL_WORKSPACE);
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
                role: newRole,
            },
        ]);
    }

    function handleChangeShareRole(email: string, role: ProjectRole) {
        setSharedUsers((prev) =>
            prev.map((entry) =>
                entry.email === email ? { ...entry, role } : entry,
            ),
        );
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

                        {orgs.length > 0 && (
                            <div>
                                <FieldLabel htmlFor="new-project-org">
                                    Organization
                                </FieldLabel>
                                <ModalSelect
                                    id="new-project-org"
                                    value={orgId}
                                    onChange={setOrgId}
                                    options={[
                                        {
                                            value: PERSONAL_WORKSPACE,
                                            label: "Personal workspace",
                                        },
                                        ...orgs.map((org) => ({
                                            value: org.id,
                                            label: org.name,
                                        })),
                                    ]}
                                />
                            </div>
                        )}

                        <div className="space-y-2">
                            <FieldLabel as="p">
                                Share with
                            </FieldLabel>
                            <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
                                    <AddUserInput
                                        onAdd={handleAddShareUser}
                                        validateEmail={validateShareUser}
                                        placeholder="Add colleagues by email..."
                                        // A grant is claimed by email when its
                                        // recipient signs up, so outside
                                        // counsel can be invited before they
                                        // have an account — the same reason
                                        // the share dialog passes false.
                                        requireExistingUser={false}
                                    />
                                </div>
                                <select
                                    aria-label="Role for the new recipient"
                                    value={newRole}
                                    onChange={(event) => {
                                        if (isProjectRole(event.target.value))
                                            setNewRole(event.target.value);
                                    }}
                                    disabled={loading}
                                    title={PROJECT_ROLE_DESCRIPTIONS[newRole]}
                                    className={cn(ROLE_SELECT_CLASS, "mt-2 h-8")}
                                >
                                    {PROJECT_ROLES.map((role) => (
                                        <option key={role} value={role}>
                                            {PROJECT_ROLE_LABELS[role]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <p className="text-xs text-gray-500">
                                {PROJECT_ROLE_LABELS[newRole]}:{" "}
                                {PROJECT_ROLE_DESCRIPTIONS[newRole]}
                            </p>
                            {sharedUsers.length > 0 && (
                                <ul className="space-y-1 pt-1">
                                    {sharedUsers.map((entry) => {
                                        const displayName =
                                            entry.display_name?.trim();
                                        // An address with no Mike account has
                                        // no display name yet; showing "User"
                                        // for it would hide who was invited.
                                        const primary =
                                            displayName || entry.email;
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
                                                        {displayName && (
                                                            <span className="text-gray-400">
                                                                {" "}
                                                                · {entry.email}
                                                            </span>
                                                        )}
                                                    </p>
                                                </div>
                                                <select
                                                    aria-label={`Role for ${entry.email}`}
                                                    value={entry.role}
                                                    onChange={(event) => {
                                                        if (
                                                            isProjectRole(
                                                                event.target
                                                                    .value,
                                                            )
                                                        )
                                                            handleChangeShareRole(
                                                                entry.email,
                                                                event.target
                                                                    .value,
                                                            );
                                                    }}
                                                    disabled={loading}
                                                    title={
                                                        PROJECT_ROLE_DESCRIPTIONS[
                                                            entry.role
                                                        ]
                                                    }
                                                    className={cn(
                                                        ROLE_SELECT_CLASS,
                                                        "shrink-0",
                                                    )}
                                                >
                                                    {PROJECT_ROLES.map(
                                                        (role) => (
                                                            <option
                                                                key={role}
                                                                value={role}
                                                            >
                                                                {
                                                                    PROJECT_ROLE_LABELS[
                                                                        role
                                                                    ]
                                                                }
                                                            </option>
                                                        ),
                                                    )}
                                                </select>
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
