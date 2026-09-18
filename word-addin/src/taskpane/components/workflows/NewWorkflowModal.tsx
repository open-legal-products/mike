import React, { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { WorkflowSlashCommandUI } from "@mike/workflow-slash-command-ui";
import type { Workflow } from "../../types";
import { createWorkflow } from "../../api/mikeApi";
import { Modal } from "../primitives/Modal";
import {
  ModalFieldLabel,
  ModalSelect,
  ModalTextInput,
} from "../primitives/ModalForm";
import {
  DEFAULT_WORKFLOW_JURISDICTION,
  DEFAULT_WORKFLOW_LANGUAGE,
  DEFAULT_WORKFLOW_PRACTICE,
  WORKFLOW_JURISDICTION_OPTIONS,
  WORKFLOW_LANGUAGE_OPTIONS,
  WORKFLOW_PRACTICE_OPTIONS,
} from "../../lib/workflowMetadata";
import { userMessage } from "../../lib/notify";

const US_STATE_OPTIONS = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
  "District of Columbia",
] as const;

const CANADA_PROVINCE_OPTIONS = [
  "Alberta",
  "British Columbia",
  "Manitoba",
  "New Brunswick",
  "Newfoundland and Labrador",
  "Northwest Territories",
  "Nova Scotia",
  "Nunavut",
  "Ontario",
  "Prince Edward Island",
  "Quebec",
  "Saskatchewan",
  "Yukon",
] as const;

interface NewWorkflowModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (workflow: Workflow) => void;
}

export function NewWorkflowModal({
  open,
  onClose,
  onCreated,
}: NewWorkflowModalProps): React.ReactElement | null {
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState(DEFAULT_WORKFLOW_LANGUAGE);
  const [customLanguage, setCustomLanguage] = useState("");
  const [practice, setPractice] = useState(DEFAULT_WORKFLOW_PRACTICE);
  const [customPractice, setCustomPractice] = useState("");
  const [jurisdiction, setJurisdiction] = useState(
    DEFAULT_WORKFLOW_JURISDICTION
  );
  const [jurisdictionRegion, setJurisdictionRegion] = useState("");
  const [customJurisdiction, setCustomJurisdiction] = useState("");
  const [importedMarkdown, setImportedMarkdown] = useState("");
  const [importedFileName, setImportedFileName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markdownInputRef = useRef<HTMLInputElement>(null);

  const reset = (): void => {
    setTitle("");
    setLanguage(DEFAULT_WORKFLOW_LANGUAGE);
    setCustomLanguage("");
    setPractice(DEFAULT_WORKFLOW_PRACTICE);
    setCustomPractice("");
    setJurisdiction(DEFAULT_WORKFLOW_JURISDICTION);
    setJurisdictionRegion("");
    setCustomJurisdiction("");
    setImportedMarkdown("");
    setImportedFileName(null);
    setError(null);
    if (markdownInputRef.current) markdownInputRef.current.value = "";
  };

  useEffect(() => {
    if (open) reset();
  }, [open]);

  if (!open) return null;

  const close = (): void => {
    if (creating) return;
    reset();
    onClose();
  };

  const create = async (): Promise<void> => {
    if (!title.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const effectiveLanguage =
        language === "Other" ? customLanguage.trim() : language;
      const effectivePractice =
        practice === "Other" ? customPractice.trim() : practice;
      const effectiveJurisdiction =
        jurisdiction === "Other"
          ? customJurisdiction.trim()
          : jurisdictionRegion || jurisdiction;
      const workflow = await createWorkflow({
        metadata: {
          title: title.trim(),
          type: "assistant",
          language: effectiveLanguage || null,
          practice: effectivePractice || null,
          jurisdictions: effectiveJurisdiction
            ? effectiveJurisdiction
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            : null,
        },
        ...(importedMarkdown ? { skill_md: importedMarkdown } : {}),
      });
      onCreated(workflow);
      reset();
      onClose();
    } catch (reason) {
      setError(
        userMessage(reason, {
          fallback: "Mike couldn't create that workflow. Try again.",
        })
      );
    } finally {
      setCreating(false);
    }
  };

  const importMarkdown = async (
    event: React.ChangeEvent<HTMLInputElement>
  ): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/\.(?:md|markdown)$/i.test(file.name)) {
      setImportedMarkdown("");
      setImportedFileName(null);
      setError("Choose a .md or .markdown file.");
      event.target.value = "";
      return;
    }
    try {
      setImportedMarkdown(await file.text());
      setImportedFileName(file.name);
      setError(null);
    } catch {
      setImportedMarkdown("");
      setImportedFileName(null);
      setError("Could not read that Markdown file.");
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      parentLabel="Workflows"
      title="New workflow"
      primaryAction={{
        label: creating ? "Creating…" : "Create workflow",
        onClick: () => void create(),
        disabled: !title.trim() || creating,
      }}
      secondaryAction={{
        label: importedFileName ?? "Upload markdown",
        icon: <Upload className="h-3.5 w-3.5" />,
        onClick: () => markdownInputRef.current?.click(),
        disabled: creating,
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto pb-5">
        <div className="space-y-6">
          <div>
            <ModalFieldLabel htmlFor="new-workflow-title">
              Title
            </ModalFieldLabel>
            <ModalTextInput
              id="new-workflow-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Add workflow name"
              variant="minimal"
              autoFocus
            />
            <WorkflowSlashCommandUI title={title} />
          </div>

          <div>
            <ModalFieldLabel htmlFor="new-workflow-language">
              Language
            </ModalFieldLabel>
            <ModalSelect
              id="new-workflow-language"
              value={language}
              options={WORKFLOW_LANGUAGE_OPTIONS}
              onChange={(value) => {
                setLanguage(value);
                if (value !== "Other") setCustomLanguage("");
              }}
            />
            {language === "Other" && (
              <ModalTextInput
                value={customLanguage}
                onChange={(event) => setCustomLanguage(event.target.value)}
                placeholder="Enter language…"
                className="mt-2"
              />
            )}
          </div>

          <div>
            <ModalFieldLabel htmlFor="new-workflow-practice">
              Practice area
            </ModalFieldLabel>
            <ModalSelect
              id="new-workflow-practice"
              value={practice}
              options={WORKFLOW_PRACTICE_OPTIONS}
              onChange={(value) => {
                setPractice(value);
                if (value !== "Other") setCustomPractice("");
              }}
            />
            {practice === "Other" && (
              <ModalTextInput
                value={customPractice}
                onChange={(event) => setCustomPractice(event.target.value)}
                placeholder="Enter practice area…"
                className="mt-2"
              />
            )}
          </div>

          <div>
            <ModalFieldLabel htmlFor="new-workflow-jurisdiction">
              Jurisdiction
            </ModalFieldLabel>
            <ModalSelect
              id="new-workflow-jurisdiction"
              value={jurisdiction}
              options={WORKFLOW_JURISDICTION_OPTIONS}
              onChange={(value) => {
                setJurisdiction(value);
                setJurisdictionRegion("");
                if (value !== "Other") setCustomJurisdiction("");
              }}
            />
            {(jurisdiction === "United States" ||
              jurisdiction === "Canada") && (
              <ModalSelect
                id="new-workflow-jurisdiction-region"
                value={jurisdictionRegion}
                options={
                  jurisdiction === "United States"
                    ? US_STATE_OPTIONS
                    : CANADA_PROVINCE_OPTIONS
                }
                onChange={setJurisdictionRegion}
                placeholder={
                  jurisdiction === "United States"
                    ? "Select state…"
                    : "Select province…"
                }
                className="mt-2"
              />
            )}
            {jurisdiction === "Other" && (
              <ModalTextInput
                value={customJurisdiction}
                onChange={(event) => setCustomJurisdiction(event.target.value)}
                placeholder="Enter jurisdiction…"
                className="mt-2"
              />
            )}
          </div>

          {importedFileName && (
            <p className="text-xs text-gray-500">
              The imported Markdown will become the workflow instructions.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-500">
              {error}
            </p>
          )}
        </div>
        <input
          ref={markdownInputRef}
          type="file"
          className="hidden"
          accept=".md,.markdown,text/markdown,text/x-markdown,text/plain"
          onChange={(event) => void importMarkdown(event)}
        />
      </div>
    </Modal>
  );
}
