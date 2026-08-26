"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import type { Document, Folder, Project, Workflow } from "../shared/types";
import {
    getProject,
    listWorkflows,
    uploadProjectDocument,
    uploadStandaloneDocument,
} from "@/app/lib/mikeApi";
import { FileDirectory } from "../shared/FileDirectory";
import { Modal } from "../modals/Modal";
import { ModalSelect } from "../modals/ModalSelect";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};
const TABULAR_DIRECTORY_TABS = ["files", "projects"] as const;

interface Props {
    open: boolean;
    onClose: () => void;
    onAdd: (
        title: string,
        projectId?: string,
        documentIds?: string[],
        columnsConfig?: Workflow["columns_config"],
        documentGrouping?: "document" | "folder",
    ) => void;
    projects?: Project[];
    /** When provided, skip the project/directory picker and show only these docs */
    projectDocs?: Document[];
    projectFolders?: Folder[];
    projectId?: string;
    projectName?: string;
    projectCmNumber?: string | null;
}

export function NewTRModal({
    open,
    onClose,
    onAdd,
    projects = [],
    projectDocs: fixedProjectDocs,
    projectFolders: fixedProjectFolders,
    projectId,
    projectName,
    projectCmNumber,
}: Props) {
    const isProjectMode = projectId !== undefined;
    const [step, setStep] = useState<"details" | "documents">("details");
    const [title, setTitle] = useState("");
    const [underProject, setUnderProject] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState("");

    // Project-scoped docs fetched for the "under project" toggle. In project
    // mode the list comes from the fixedProjectDocs prop instead, so this only
    // holds documents uploaded from inside the modal.
    const [projectDocs, setProjectDocs] = useState<Document[]>([]);
    const [projectFolders, setProjectFolders] = useState<Folder[]>([]);
    const [loadingDocs, setLoadingDocs] = useState(false);

    const [extraStandaloneDocs, setExtraStandaloneDocs] = useState<Document[]>(
        [],
    );
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [groupBySubfolder, setGroupBySubfolder] = useState(false);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Workflow templates
    const [workflows, setWorkflows] = useState<Workflow[]>([]);
    const [loadingWorkflows, setLoadingWorkflows] = useState(false);
    const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
        null,
    );
    const formId = "new-tabular-review-modal-form";
    const preselectedProjectDocsRef = useRef(false);

    // Derived, not copied into state: the parent passes `[]` until the project
    // has loaded, so a snapshot taken when the modal opened left the picker
    // permanently empty for anyone who opened it early.
    const projectModeDocs: Document[] = [];
    if (isProjectMode) {
        const seen = new Set<string>();
        for (const doc of [...projectDocs, ...(fixedProjectDocs ?? [])]) {
            if (seen.has(doc.id)) continue;
            seen.add(doc.id);
            projectModeDocs.push(doc);
        }
    }
    const projectModeDocsKey = projectModeDocs.map((doc) => doc.id).join(",");

    useEffect(() => {
        if (!open) return;

        setLoadingWorkflows(true);
        listWorkflows("tabular")
            .then((workflows) => {
                devLog("[workflows/ui:tabular-review-modal] loaded", {
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
            })
            .catch((error) => {
                devLog(
                    "[workflows/ui:tabular-review-modal] failed",
                    error,
                );
                setWorkflows([]);
            })
            .finally(() => setLoadingWorkflows(false));

        if (isProjectMode) preselectedProjectDocsRef.current = false;
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    // Preselect every project document once, as soon as they're available —
    // which may be after the modal opened, since the parent's list is empty
    // while the project is still loading. Only the first non-empty list wins,
    // so later renders don't stomp on the user's own selection.
    useEffect(() => {
        if (!open || !isProjectMode) return;
        if (preselectedProjectDocsRef.current || !projectModeDocs.length)
            return;
        preselectedProjectDocsRef.current = true;
        setSelectedDocuments(projectModeDocs);
    }, [open, isProjectMode, projectModeDocsKey]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!open) return null;

    function handleClose() {
        setStep("details");
        setTitle("");
        setUnderProject(false);
        setSelectedProjectId("");
        setProjectDocs([]);
        setProjectFolders([]);
        setExtraStandaloneDocs([]);
        setSelectedDocuments([]);
        setGroupBySubfolder(false);
        setSelectedWorkflowId(null);
        onClose();
    }

    function submitterValue(e: React.FormEvent<HTMLFormElement>) {
        return (
            (e.nativeEvent as SubmitEvent).submitter as
                | HTMLButtonElement
                | null
        )?.value;
    }

    function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!title.trim()) return;
        if (underProject && !selectedProjectId) return;
        if (step === "details" || submitterValue(e) !== "create-review") {
            setStep("documents");
            return;
        }
        const selectedWorkflow = workflows.find(
            (w) => w.id === selectedWorkflowId,
        );
        onAdd(
            title.trim(),
            underProject ? selectedProjectId : undefined,
            selectedDocuments.length > 0
                ? selectedDocuments.map((document) => document.id)
                : undefined,
            selectedWorkflow?.columns_config ?? undefined,
            groupBySubfolder ? "folder" : "document",
        );
        handleClose();
    }

    async function handleSelectProject(projectId: string) {
        setSelectedProjectId(projectId);
        setProjectDocs([]);
        setProjectFolders([]);
        setSelectedDocuments([]);
        setLoadingDocs(true);
        try {
            const proj = await getProject(projectId);
            const docs = (proj.documents ?? []).filter(
                (d) => d.status === "ready",
            );
            setProjectDocs(docs);
            setProjectFolders(proj.folders ?? []);
            setSelectedDocuments(docs);
        } finally {
            setLoadingDocs(false);
        }
    }

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? []);
        if (!files.length) return;
        setUploading(true);
        try {
            const uploadProjectId = isProjectMode
                ? projectId
                : underProject
                  ? selectedProjectId
                  : undefined;
            const uploaded = await Promise.all(
                files.map((f) =>
                    uploadProjectId
                        ? uploadProjectDocument(uploadProjectId, f)
                        : uploadStandaloneDocument(f),
                ),
            );
            if (uploadProjectId) {
                setProjectDocs((prev) => [...uploaded, ...prev]);
            } else {
                setExtraStandaloneDocs((prev) => [...uploaded, ...prev]);
            }
            setSelectedDocuments((prev) => [
                ...prev,
                ...uploaded.filter(
                    (document) =>
                        !prev.some((selected) => selected.id === document.id),
                ),
            ]);
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    const workflowOptions = [
        {
            value: "",
            label: loadingWorkflows
                ? "Loading templates..."
                : "No template - start from scratch",
        },
        ...workflows.map((workflow) => ({
            value: workflow.id,
            label: workflow.metadata.title,
        })),
    ];
    const projectOptions = projects.length
        ? projects.map((project) => ({
              value: project.id,
              label:
                  project.name +
                  (project.cm_number ? ` (#${project.cm_number})` : ""),
          }))
        : [{ value: "", label: "No projects found" }];

    // What to show in the directory depends on mode and toggle state
    const directoryDocuments = isProjectMode
        ? projectModeDocs
        : underProject
          ? projectDocs
          : extraStandaloneDocs;
    const directoryFolders = isProjectMode
        ? (fixedProjectFolders ?? [])
        : underProject
          ? projectFolders
          : [];
    const directoryLoading = isProjectMode
        ? false
        : underProject
          ? loadingDocs
          : false;
    const showDirectory = isProjectMode || !underProject || !!selectedProjectId;
    const breadcrumbs =
        isProjectMode && projectName
            ? [
                  "Projects",
                  `${projectName}${projectCmNumber ? ` (#${projectCmNumber})` : ""}`,
                  "New Tabular Review",
              ]
            : ["Tabular Reviews", "New Tabular Review"];

    return (
        <Modal
            open={open}
            onClose={handleClose}
            breadcrumbs={[
                ...breadcrumbs,
                step === "details" ? "Details" : "Add Documents",
            ]}
            secondaryAction={
                step === "documents"
                    ? {
                          label: uploading ? "Uploading..." : "Upload",
                          icon: uploading ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                              <Upload className="h-3.5 w-3.5" />
                          ),
                          onClick: () => fileInputRef.current?.click(),
                          disabled: uploading,
                      }
                    : undefined
            }
            cancelAction={
                step === "documents"
                    ? {
                          label: "Back",
                          onClick: () => setStep("details"),
                          disabled: uploading,
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
                          disabled:
                              !title.trim() ||
                              (underProject && !selectedProjectId),
                      }
                    : {
                          label: "Create",
                          type: "submit",
                          form: formId,
                          name: "modalAction",
                          value: "create-review",
                          disabled:
                              !title.trim() ||
                              (underProject && !selectedProjectId),
                      }
            }
        >
            <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt"
                multiple
                className="hidden"
                onChange={handleUpload}
            />
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="flex flex-col min-h-0 flex-1"
            >
                {step === "details" ? (
                    <div className="space-y-6">
                        <div>
                            <FieldLabel htmlFor="new-tr-title">
                                Review name
                            </FieldLabel>
                            <FormTextInput
                                id="new-tr-title"
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Review name"
                                variant="minimal"
                                className="placeholder:text-gray-400"
                                autoFocus
                            />
                        </div>

                        {/* Workflow template */}
                        <div>
                            <FieldLabel as="p">
                                Workflow template
                            </FieldLabel>
                            <ModalSelect
                                id="new-tr-workflow-template"
                                value={selectedWorkflowId ?? ""}
                                options={workflowOptions}
                                onChange={(value) =>
                                    setSelectedWorkflowId(value || null)
                                }
                                disabled={loadingWorkflows}
                            />
                        </div>

                        {/* Create under a project toggle */}
                        {!isProjectMode && (
                            <div className="space-y-3">
                                <FieldLabel as="p">
                                    Project
                                </FieldLabel>
                                <ToggleSwitch
                                    checked={underProject}
                                    onCheckedChange={(next) => {
                                        setUnderProject(next);
                                        if (!next) {
                                            setSelectedProjectId("");
                                            setProjectDocs([]);
                                            setProjectFolders([]);
                                            setSelectedDocuments([]);
                                        }
                                    }}
                                >
                                    Create under a project
                                </ToggleSwitch>

                                {underProject && (
                                    <ModalSelect
                                        id="new-tr-project"
                                        value={selectedProjectId}
                                        options={projectOptions}
                                        onChange={(value) => {
                                            if (value) {
                                                void handleSelectProject(value);
                                            }
                                        }}
                                        placeholder="Select project..."
                                        disabled={projects.length === 0}
                                    />
                                )}
                            </div>
                        )}

                        <div>
                            <FieldLabel as="p">
                                Document grouping
                            </FieldLabel>
                            <ToggleSwitch
                                checked={groupBySubfolder}
                                onCheckedChange={setGroupBySubfolder}
                            >
                                Treat documents in the same folder as one review row
                            </ToggleSwitch>
                        </div>
                    </div>
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                        {showDirectory && (
                            <FileDirectory
                                documents={directoryDocuments}
                                folders={directoryFolders}
                                loading={directoryLoading}
                                selectedDocuments={selectedDocuments}
                                onChange={setSelectedDocuments}
                                showTabs={!isProjectMode && !underProject}
                                tabs={TABULAR_DIRECTORY_TABS}
                            />
                        )}
                    </div>
                )}
            </form>
        </Modal>
    );
}
