import React from "react";
import { EditCardUI } from "@mike/edit-card-ui";
import type { RedlineEdit } from "../../lib/redline";
import { EDIT_CARD_SURFACE } from "./message/messageStyles";
import type { EditBusyAction, EditCardStatus } from "../../lib/wordChatTypes";
import {
  ALREADY_APPLIED_MESSAGE,
  UNVERIFIED_APPLY_MESSAGE,
} from "../../lib/editApplyOutcome";

interface EditCardProps {
  /** Fields can arrive independently while a streamed edit is being parsed. */
  edit: Partial<RedlineEdit>;
  changeNumber?: number;
  status?: EditCardStatus;
  /** How many places Word found the original text, when it reported it. */
  matches?: number;
  /** How many occurrences a replace-all edit actually applied. */
  appliedMatches?: number;
  /** Snippet of the paragraph the edit landed in. */
  locationHint?: string;
  /** Scrolls Word to the revision this card applied. */
  onView?: () => void;
  onApply?: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  /**
   * Conflicted card only: accept the pending tracked changes occupying the
   * target passage, then apply this edit as a fresh redline.
   */
  onAcceptAndApply?: () => void;
  /** What Word reported, shown in place of the generic status copy. */
  error?: string;
  /** Disables both resolution actions while a Word operation is in flight. */
  disabled?: boolean;
  /** The action currently mutating or navigating the Word document. */
  busyAction?: EditBusyAction;
}

const STATUS_COPY: Record<
  Exclude<EditCardStatus, "pending" | "ready" | "applying-approved">,
  { copy: string; className: string }
> = {
  receiving: { copy: "Receiving change…", className: "text-gray-400" },
  validating: { copy: "Checking the document…", className: "text-gray-400" },
  applying: { copy: "Applying to the document…", className: "text-gray-500" },
  restoring: { copy: "Checking the document…", className: "text-gray-400" },
  "view-only": {
    copy: "Tracked change found — review it in Word.",
    className: "text-gray-500",
  },
  applied: { copy: "Applied to the document.", className: "text-green-700" },
  accepted: { copy: "Accepted.", className: "text-green-700" },
  rejected: { copy: "Rejected.", className: "text-gray-500" },
  skipped: {
    copy: "Skipped — this change could not be applied.",
    className: "text-gray-500",
  },
  ambiguous: {
    copy: "Skipped — source text appears more than once.",
    className: "text-gray-500",
  },
  unsearchable: {
    copy: "Skipped — this passage is too long for Word’s search or spans paragraphs.",
    className: "text-gray-500",
  },
  conflicted: {
    copy: "Skipped — the target text already has tracked changes. Accept & apply resolves them, then applies this change.",
    className: "text-gray-500",
  },
  "already-applied": {
    copy: ALREADY_APPLIED_MESSAGE,
    className: "text-gray-500",
  },
  // No action is offered here on purpose: retrying an edit that DID land
  // would put a second revision over the first.
  unverified: {
    copy: UNVERIFIED_APPLY_MESSAGE,
    className: "text-amber-700",
  },
  incomplete: {
    copy: "Incomplete change — not applied.",
    className: "text-gray-500",
  },
  unmanaged: {
    copy: "Applied in Word — review it from Word’s Review tab.",
    className: "text-amber-700",
  },
  error: { copy: "Couldn’t apply this change.", className: "text-red-500" },
  historical: { copy: "Historical change.", className: "text-gray-400" },
};

/**
 * A single proposed tracked change, rendered with the web app's EditCard
 * look: reason line, then the replacement in green and the original in red
 * strikethrough on a serif gray slab. Its lifecycle is controlled by the
 * caller so Word mutations stay outside this presentational component.
 */
export function EditCard({
  edit,
  changeNumber,
  status = "pending",
  matches,
  appliedMatches,
  locationHint,
  onView,
  onApply,
  onAccept,
  onReject,
  onAcceptAndApply,
  error,
  disabled = false,
  busyAction,
}: EditCardProps): React.ReactElement {
  const formats = edit.format ?? [];
  const isFormatCard = formats.length > 0;
  const formatPreviewClass = [
    formats.includes("bold") ? "font-bold" : "",
    formats.includes("italic") ? "italic" : "",
    formats.includes("underline") ? "underline" : "",
    // Heading styles: approximate Word's visual hierarchy in the preview.
    formats.includes("heading1") ? "font-bold text-lg" : "",
    formats.includes("heading2") ? "font-bold text-base" : "",
    formats.includes("heading3") ? "font-semibold" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const formatLabels = formats
    .map((format) =>
      format.startsWith("heading")
        ? `heading ${format.slice("heading".length)}`
        : format,
    )
    .join(", ");
  const hasEditText =
    edit.replacement !== undefined || edit.original !== undefined;
  const statusCopy =
    status === "pending" || status === "ready" || status === "applying-approved"
      ? undefined
      : STATUS_COPY[status];
  // The generic ambiguous copy upgrades to an actionable one when Word
  // reported how many places the passage matched.
  const ambiguousCopy =
    status === "ambiguous" && matches !== undefined && matches > 1
      ? `Skipped — this text appears ${matches} times in the document. Tell Mike which one to change.`
      : undefined;
  // A replace-all edit names its breadth so "Applied" can't be misread as a
  // single change.
  const multiApplyCopy =
    status === "applied" && appliedMatches !== undefined && appliedMatches > 1
      ? `Applied to the document in ${appliedMatches} places.`
      : undefined;
  // Most statuses already say something precise. These states may carry a
  // more useful message from Word or the edit-application pipeline.
  const message =
    status === "pending" ||
    status === "ready" ||
    status === "view-only" ||
    status === "skipped" ||
    status === "already-applied" ||
    status === "unverified" ||
    status === "error" ||
    status === "historical"
      ? (error ?? statusCopy?.copy)
      : (ambiguousCopy ?? multiApplyCopy ?? statusCopy?.copy);
  const messageClass =
    status === "pending" || status === "ready"
      ? "text-amber-700"
      : (statusCopy?.className ?? "");

  return (
    <EditCardUI
      originalText={edit.original}
      replacementText={edit.replacement}
      previewContent={
        // A format-only change keeps the text; preview the styling on the
        // original passage instead of a red/green replacement.
        isFormatCard && hasEditText ? (
          <>
            <span className={`text-gray-800 ${formatPreviewClass}`}>
              {edit.original}
            </span>
            <span className="ml-2 text-gray-400">{formatLabels}</span>
          </>
        ) : undefined
      }
      reason={edit.reason}
      locationHint={
        // Show where the change landed only while its location is still
        // reviewable; resolved and skipped cards drop the extra line.
        status === "pending" || status === "applied" || status === "unmanaged"
          ? locationHint
          : undefined
      }
      changeNumber={changeNumber}
      status={status}
      statusMessage={message}
      statusMessageClassName={messageClass}
      className={`${EDIT_CARD_SURFACE} p-3`}
      ariaBusy={
        disabled ||
        status === "receiving" ||
        status === "validating" ||
        status === "applying" ||
        status === "applying-approved" ||
        status === "restoring"
      }
      actionsDisabled={disabled}
      busyAction={busyAction}
      onView={onView}
      onApply={onApply}
      onAccept={onAccept}
      onReject={onReject}
      // Supersede occupying revisions on an explicit click, then apply this
      // edit as a clean redline.
      onAcceptAndApply={onAcceptAndApply}
    />
  );
}
