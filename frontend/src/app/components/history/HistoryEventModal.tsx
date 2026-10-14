"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { HistorySubjectIcon } from "./HistorySubjectIcon";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { workflowDetailPath } from "@/app/components/workflows/workflowRoutes";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ChevronDown } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";
import type { PanelDocument } from "@/app/components/shared/types";
import {
  getDocument,
  getWorkflow,
  openOrgPrivateContent,
  closeOrgPrivateContent,
  MikeApiError,
  type AuditEvent,
} from "@/app/lib/mikeApi";
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import {
  auditAction,
  auditActor,
  auditDestination,
  auditDetailFields,
  auditLabel,
  auditPrivateAccess,
  auditSubject,
  auditSubjectEmail,
  auditSummary,
  auditTimestamp,
  SURFACE_LABELS,
} from "./auditPresentation";

const DocumentContent = lazy(() =>
  import("@/app/components/shared/DocumentContent").then((module) => ({
    default: module.DocumentContent,
  })),
);

export function HistoryEventModal({
  title,
  event,
  personal,
  initialPreview = false,
  onClose,
  onAccessChange,
}: {
  title: string;
  event: AuditEvent;
  personal: boolean;
  initialPreview?: boolean;
  onClose: () => void;
  onAccessChange?: (hasAccess: boolean) => void;
}) {
  const router = useRouter();
  const privateAccess = personal ? null : auditPrivateAccess(event);
  const documentId =
    event.document_id ??
    (privateAccess?.kind === "document" ? privateAccess.item_id : null);
  const [preview, setPreview] = useState(
    initialPreview && Boolean(documentId) && !privateAccess,
  );
  const [hasAccess, setHasAccess] = useState(
    privateAccess?.has_access ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [document, setDocument] = useState<PanelDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!preview || !documentId) return;
    let current = true;
    void getDocument(documentId)
      .then((loaded) => {
        if (current)
          setDocument({
            document_id: loaded.id,
            title: loaded.filename,
            type: resolveDocumentViewType({
              filename: loaded.filename,
              fileType: loaded.file_type,
            }),
            version_id: loaded.current_version_id ?? undefined,
            version_number: loaded.active_version_number ?? undefined,
            metadata: [],
            quotes: [],
          });
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setError(
          cause instanceof MikeApiError && cause.status === 403
            ? "You do not have access to this document."
            : cause instanceof MikeApiError && cause.status === 404
              ? "This document is no longer available."
              : knownErrorCodeMessage(
                  cause,
                  {},
                  "This document could not be opened. Please try again.",
                ),
        );
      });
    return () => {
      current = false;
    };
  }, [documentId, preview, attempt]);
  async function withAccess(action: () => void | Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setActionError(null);
    try {
      // Each explicit opening is logged before any content fetch or navigation.
      if (privateAccess && event.org_id) {
        await openOrgPrivateContent(
          event.org_id,
          privateAccess.kind,
          privateAccess.item_id,
        );
        if (!mounted.current) return;
        setHasAccess(true);
        onAccessChange?.(true);
      }
      if (mounted.current) await action();
    } catch (cause) {
      if (mounted.current)
        setActionError(privateAccessError(cause, "Could not open this item."));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const openPreview = () =>
    void withAccess(() => {
      setDocument(null);
      setError(null);
      setPreview(true);
    });
  async function endAccess() {
    if (!privateAccess || !event.org_id || pending.current) return;
    pending.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await closeOrgPrivateContent(
        event.org_id,
        privateAccess.kind,
        privateAccess.item_id,
      );
      if (!mounted.current) return;
      setHasAccess(false);
      setDocument(null);
      onAccessChange?.(false);
    } catch (cause) {
      if (mounted.current)
        setActionError(privateAccessError(cause, "Could not end access."));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const retryPreview = () => {
    setError(null);
    setAttempt((value) => value + 1);
  };
  const subject = auditSubject(event);
  const subjectEmail = auditSubjectEmail(event);
  const destination = auditDestination(event);
  const fields = [
    { label: "Description", value: auditSummary(event, personal) },
    ...(!personal
      ? [
          {
            label: "Performed by",
            value: (
              <span className="inline-flex max-w-full items-start justify-end gap-2">
                {auditActor(event) !== "System" && (
                  <UserAvatar
                    photo={event.user_profile_photo}
                    name={event.user_display_name}
                    email={event.user_email}
                    className="mt-0.5"
                  />
                )}
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {`${auditActor(event)}${event.user_email && event.user_display_name ? ` (${event.user_email})` : ""}`}
                </span>
              </span>
            ),
          },
        ]
      : []),
    {
      label: subject.type,
      value:
        ["Member", "Recipient"].includes(subject.type) &&
        subject.name !== "-" ? (
          <span className="inline-flex max-w-full items-start justify-end gap-2">
            <HistorySubjectIcon event={event} />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {`${subject.name}${subjectEmail && subjectEmail !== subject.name ? ` (${subjectEmail})` : ""}`}
            </span>
          </span>
        ) : (
          subject.name
        ),
    },
    ...auditDetailFields(event).filter(
      (field) => !privateAccess || field.label !== "Access",
    ),
    ...(subject.context &&
    subject.context !== (SURFACE_LABELS[event.surface ?? ""] ?? event.surface)
      ? [{ label: "Location", value: subject.context }]
      : []),
    { label: "When", value: auditTimestamp(event.created_at, true) },
    { label: "Status", value: auditLabel(event.status) },
    ...(privateAccess
      ? [{ label: "Access", value: "Read-only · access is logged" }]
      : []),
    ...(event.surface
      ? [
          {
            label: "Application",
            value: SURFACE_LABELS[event.surface] ?? auditLabel(event.surface),
          },
        ]
      : []),
    ...(event.model ? [{ label: "Model", value: event.model }] : []),
  ];

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size={preview ? "xl" : "md"}
        className={`[&>footer]:flex-wrap [&>footer>div]:flex-wrap [&>footer>div]:justify-end [&>footer_a]:whitespace-nowrap [&>footer_button]:whitespace-nowrap ${
          preview
            ? "h-[min(800px,calc(100dvh-2rem))]"
            : "h-auto max-h-[calc(100dvh-2rem)]"
        }`}
        breadcrumbs={[title, preview ? "Document" : "Event details"]}
        primaryAction={
          preview
            ? error
              ? { label: "Try again", onClick: retryPreview }
              : undefined
            : documentId
              ? {
                  label: busy ? "Opening…" : "Open document",
                  onClick: openPreview,
                  disabled: busy,
                }
              : undefined
        }
        secondaryAction={
          preview
            ? { label: "Back", onClick: () => setPreview(false) }
            : privateAccess && hasAccess
              ? {
                  label: "End access",
                  onClick: () => void endAccess(),
                  disabled: busy,
                  variant: "secondary",
                }
              : undefined
        }
        footerStatus={
          !preview && (destination || privateAccess?.kind === "workflow") ? (
            privateAccess ? (
              <PillButtonUI
                tone={documentId ? "white" : "black"}
                disabled={busy}
                onClick={() =>
                  void withAccess(async () => {
                    const href =
                      destination?.href ??
                      workflowDetailPath(
                        await getWorkflow(privateAccess.item_id),
                      );
                    if (mounted.current) router.push(href);
                  })
                }
              >
                {busy ? "Opening…" : (destination?.label ?? "Open workflow")}
              </PillButtonUI>
            ) : destination ? (
              <Link
                href={destination.href}
                className={pillButtonUIClassName({
                  tone: documentId ? "white" : "black",
                  size: "normal",
                })}
              >
                {destination.label}
              </Link>
            ) : undefined
          ) : undefined
        }
      >
        {preview && documentId ? (
          <HistoryDocumentPreview document={document} error={error} />
        ) : (
          <div
            data-modal-scroll="vertical"
            className="min-h-0 overflow-y-auto pb-5"
          >
            <h2 className="font-serif text-2xl text-gray-900 [overflow-wrap:anywhere]">
              {auditAction(event)}
            </h2>
            <table
              className="mt-4 w-full table-fixed text-left"
              aria-label="Event details"
            >
              <tbody className="divide-y divide-border">
                {fields.map(({ label, value }) => (
                  <tr key={label}>
                    <th
                      scope="row"
                      className="w-1/3 py-2 pr-4 align-top text-xs font-normal text-gray-500 [overflow-wrap:anywhere]"
                    >
                      {label}
                    </th>
                    <td className="py-2 text-right align-top whitespace-pre-wrap text-sm text-gray-800 [overflow-wrap:anywhere]">
                      {value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details className="group mt-5">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded text-xs text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 [&::-webkit-details-marker]:hidden">
                <ChevronDown
                  aria-hidden="true"
                  className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
                />
                Technical details
              </summary>
              <table
                className="mt-3 w-full table-fixed text-left"
                aria-label="Technical details"
              >
                <tbody className="divide-y divide-border">
                  {Object.entries({
                    "Event ID": event.id,
                    "Event code": event.action,
                    "Recorded title": event.title,
                    "Organization ID": event.org_id,
                    "Project ID": event.project_id,
                    "Document ID": event.document_id,
                    "Chat ID": event.chat_id,
                    "Review ID": event.review_id,
                    ...(event.detail && Object.keys(event.detail).length
                      ? { Metadata: event.detail }
                      : {}),
                  })
                    .filter(([, value]) => value != null)
                    .map(([label, value]) => (
                      <tr key={label}>
                        <th
                          scope="row"
                          className="w-1/3 py-2 pr-4 align-top text-xs font-normal text-gray-500 [overflow-wrap:anywhere]"
                        >
                          {label}
                        </th>
                        <td className="py-2 text-right align-top whitespace-pre-wrap text-xs text-gray-700 [overflow-wrap:anywhere]">
                          {typeof value === "object"
                            ? JSON.stringify(value, null, 2)
                            : String(value)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </details>
          </div>
        )}
      </Modal>
      <WarningPopup
        open={Boolean(actionError)}
        title="Access unavailable"
        message={actionError}
        onClose={() => setActionError(null)}
      />
    </>
  );
}

function DocumentLoading() {
  return (
    <div
      role="status"
      aria-label="Loading document"
      className="flex-1 space-y-4 p-4"
    >
      <SkeletonLine className="w-48" />
      <SkeletonLine className="w-full" />
      <SkeletonLine className="w-3/4" />
    </div>
  );
}

function HistoryDocumentPreview({
  document,
  error,
}: {
  document: PanelDocument | null;
  error: string | null;
}) {
  if (error)
    return (
      <div className="flex flex-1 items-center justify-center">
        <p role="alert" className="text-center text-sm text-gray-500">
          {error}
        </p>
      </div>
    );
  if (!document) return <DocumentLoading />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<DocumentLoading />}>
        <DocumentContent
          document={document}
          mode={{ kind: "document" }}
          canEdit={false}
          cacheBytes={false}
        />
      </Suspense>
    </div>
  );
}

function privateAccessError(cause: unknown, fallback: string): string {
  if (cause instanceof MikeApiError) {
    if (cause.status === 403)
      return "You no longer have permission to access this item.";
    if (cause.status === 404) return "This item is no longer available.";
  }
  return knownErrorCodeMessage(cause, {}, fallback);
}
