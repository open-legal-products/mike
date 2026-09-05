"use client";

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import {
    type Org,
    UploadBatchError,
    addDocumentToProject,
    createProject,
    failedUploadMessage,
    grantProjectAccess,
    listOrgs,
    setProjectMemoryEnabled,
    uploadProjectDocuments,
} from "@/app/lib/mikeApi";
import { FileDirectory } from "../shared/FileDirectory";
import type { Document, Project } from "../shared/types";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { Modal } from "../modals/Modal";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { ModalSelect } from "../modals/ModalSelect";
import { ToggleSwitch } from "../ui/toggle-switch";
import { ProjectPracticeField } from "./ProjectPracticeField";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
    CreateAccessStep,
    type PendingDirectGrant,
    type PendingOrgOverride,
} from "../modals/CreateAccessStep";

const PERSONAL_WORKSPACE = "__personal__";

interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (project: Project) => void;
}

export function NewProjectModal({ open, onClose, onCreated }: Props) {
    const [step, setStep] = useState<"details" | "access" | "documents">(
        "details",
    );
    const [name, setName] = useState("");
    const [cmNumber, setCmNumber] = useState("");
    const [practice, setPractice] = useState("");
    const [sharedUsers, setSharedUsers] = useState<PendingDirectGrant[]>([]);
    const [orgOverrides, setOrgOverrides] = useState<PendingOrgOverride[]>([]);
    const [orgs, setOrgs] = useState<Org[]>([]);
    const [orgId, setOrgId] = useState<string>(PERSONAL_WORKSPACE);
    const [memoryEnabled, setMemoryEnabled] = useState(true);
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    // A project created with only some of its files attached. The modal holds
    // it until the user has read which files are missing.
    const [pendingProject, setPendingProject] = useState<Project | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const practiceEditedRef = useRef(false);
    // The project is created before its grants are written and its documents
    // are attached. Remember it so a retry after either kind of failure
    // reuses the project the user already has instead of creating a second
    // one.
    const createdProjectRef = useRef<Project | null>(null);
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const preferredPractice =
        profile?.practiceAreas.find((area) => area.trim())?.trim() ?? "";
    const ownEmail = user?.email?.trim().toLowerCase() ?? null;
    const formId = "new-project-modal-form";

    // Load the caller's organizations so a project can be created inside a
    // firm instead of the caller's private workspace. Every row is a real
    // organization now — there is no hidden personal one to filter out.
    // The selector remains visible even when the caller has no organizations.
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

    useEffect(() => {
        if (!open) {
            practiceEditedRef.current = false;
            return;
        }
        if (!preferredPractice || practiceEditedRef.current) return;
        setPractice(preferredPractice);
    }, [open, preferredPractice]);

    if (!open) return null;

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

    function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!name.trim()) return;
        if (step === "details") {
            setStep("access");
            return;
        }
        if (step === "access") {
            setStep("documents");
        }
    }

    async function createProjectFromDocuments() {
        if (!name.trim() || loading || step !== "documents") return;
        setLoading(true);
        setError("");
        try {
            if (pendingProject) {
                let project = pendingProject;
                if (project.memory_enabled !== memoryEnabled) {
                    await setProjectMemoryEnabled(project.id, memoryEnabled);
                    project = { ...project, memory_enabled: memoryEnabled };
                }
                finishCreation(project);
                return;
            }
            // Create, then grant each recipient through the role-aware access
            // endpoint, which also supports recipients without an account.
            let project = createdProjectRef.current;
            if (!project) {
                project = await createProject(
                    name.trim(),
                    cmNumber.trim() || undefined,
                    practice.trim() && practice.trim() !== "Other"
                        ? practice.trim()
                        : undefined,
                    orgId !== PERSONAL_WORKSPACE ? orgId : undefined,
                    memoryEnabled,
                );
            } else if (project.memory_enabled !== memoryEnabled) {
                // A failed grant or attachment leaves the newly created
                // project available for retry. If the user goes Back and
                // changes the memory choice, persist that choice before
                // retrying anything else; changing only the optimistic row
                // would violate an explicit opt-out.
                await setProjectMemoryEnabled(project.id, memoryEnabled);
                project = { ...project, memory_enabled: memoryEnabled };
            }
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
            const recipients = (
                orgId === PERSONAL_WORKSPACE ? sharedUsers : orgOverrides
            ).filter((entry) => !ownEmail || entry.email !== ownEmail);
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
            // creator derives Owner by definition. The same stamp the optimistic
            // chat row gets in ChatHistoryContext, for the same reason.
            const stamped = {
                ...project,
                is_owner: true,
                access_role: "owner" as const,
                access_scope:
                    orgId !== PERSONAL_WORKSPACE
                        ? ("organization" as const)
                        : recipients.length > 0
                          ? ("shared" as const)
                          : ("private" as const),
                organization_name:
                    orgs.find((org) => org.id === orgId)?.name ?? null,
                memory_enabled: memoryEnabled,
                ...(orgId === PERSONAL_WORKSPACE && recipients.length > 0
                    ? { direct_grant_count: recipients.length }
                    : {}),
            };

            if (failureMessage) {
                setError(failureMessage);
                // Nothing the user attached made it in: stay put so the primary
                // action retries the attachments against the same project,
                // instead of closing on a project with no documents.
                if (attachedCount === 0 && requestedCount > 0) return;
                // Partial success: the project is real, so let the user read
                // which files are missing before the modal hands it over.
                setPendingProject({
                    ...stamped,
                    document_count: attachedCount,
                });
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
        setName("");
        setCmNumber("");
        setPractice("");
        practiceEditedRef.current = false;
        setSharedUsers([]);
        setOrgOverrides([]);
        setSelectedDocuments([]);
        setPendingFiles([]);
        setOrgId(PERSONAL_WORKSPACE);
        setMemoryEnabled(true);
        setError("");
    }

    function handleClose() {
        resetForm();
        onClose();
    }

    return (
        <Modal
            open={open}
            onClose={handleClose}
            breadcrumbs={[
                "Projects",
                "New project",
                step === "details"
                    ? "Details"
                    : step === "access"
                      ? orgId === PERSONAL_WORKSPACE
                          ? "Access"
                          : "Organisational Access"
                      : "Add Documents",
            ]}
            secondaryAction={
                step === "documents"
                    ? {
                          label: `Upload${pendingFiles.length > 0 ? ` (${pendingFiles.length})` : ""}`,
                          icon: <Upload className="h-3.5 w-3.5" />,
                          onClick: () => fileInputRef.current?.click(),
                          disabled: loading,
                      }
                    : step === "access"
                      ? {
                            label: "Back",
                            type: "button",
                            onClick: () => setStep("details"),
                            disabled: loading,
                        }
                      : undefined
            }
            cancelAction={
                step === "documents"
                    ? {
                          label: "Back",
                          onClick: () => setStep("access"),
                          disabled: loading,
                      }
                    : step === "access"
                      ? {
                            label: "Skip",
                            type: "button",
                            onClick: () => {
                                setSharedUsers([]);
                                setOrgOverrides([]);
                                setStep("documents");
                            },
                            disabled: loading,
                        }
                      : undefined
            }
            primaryAction={
                step === "details"
                    ? {
                          label: "Next",
                          type: "button",
                          onClick: () => setStep("access"),
                          disabled: !name.trim() || loading,
                      }
                    : step === "access"
                      ? {
                            label: "Next",
                            type: "button",
                            onClick: () => setStep("documents"),
                            disabled: loading,
                        }
                      : {
                            label: loading
                                ? "Creating…"
                                : pendingProject
                                  ? "Continue"
                                  : "Create project",
                            type: "button",
                            onClick: () => void createProjectFromDocuments(),
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
                                onChange={(value) => {
                                    practiceEditedRef.current = true;
                                    setPractice(value);
                                }}
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="new-project-org">
                                Share across Organisation
                            </FieldLabel>
                            <ModalSelect
                                id="new-project-org"
                                value={orgId}
                                onChange={(value) => {
                                    setOrgId(value);
                                    setSharedUsers([]);
                                    setOrgOverrides([]);
                                }}
                                options={[
                                    {
                                        value: PERSONAL_WORKSPACE,
                                        label: "No organization",
                                    },
                                    ...orgs.map((org) => ({
                                        value: org.id,
                                        label: org.name,
                                    })),
                                ]}
                            />
                        </div>

                        <div>
                            <FieldLabel as="p">Project memory</FieldLabel>
                            <ToggleSwitch
                                checked={memoryEnabled}
                                onCheckedChange={setMemoryEnabled}
                                aria-label="Enable project memory"
                            >
                                Let Mike remember shared project context
                            </ToggleSwitch>
                            <p className="mt-1 text-xs text-gray-400">
                                Mike can curate a shared memory.md for this
                                project after conversations. Project members
                                with access can read it.
                            </p>
                        </div>
                    </div>
                ) : step === "access" ? (
                    <CreateAccessStep
                        orgId={orgId === PERSONAL_WORKSPACE ? null : orgId}
                        organizationName={
                            orgs.find((org) => org.id === orgId)?.name ?? null
                        }
                        currentUserEmail={user?.email ?? null}
                        currentUserId={user?.id ?? null}
                        directGrants={sharedUsers}
                        onDirectGrantsChange={setSharedUsers}
                        orgOverrides={orgOverrides}
                        onOrgOverridesChange={setOrgOverrides}
                        ownerLabel="Project owners"
                    />
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
