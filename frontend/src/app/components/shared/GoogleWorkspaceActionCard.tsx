"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GoogleWorkspaceActionReview } from "@mike/contracts";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import {
  decideGoogleWorkspaceAction,
  isMfaRequiredError,
  listGoogleWorkspaceActions,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

export const googleActionNames: Record<string, string> = {
  gmail_propose_send: "Send email",
  gmail_propose_save_draft: "Save draft",
  gmail_propose_delete_draft: "Delete draft",
  gmail_propose_modify: "Change email labels",
  gmail_propose_trash: "Move email to Trash",
  google_calendar_propose_create: "Create event",
  google_calendar_propose_update: "Edit event",
  google_calendar_propose_delete: "Delete event",
};

const labels: Record<string, string> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  body: "Message",
  calendar_id: "Calendar",
  event_id: "Event",
  draft_id: "Draft",
  message_id: "Message",
  summary: "Title",
  description: "Description",
  location: "Location",
  start: "Start",
  end: "End (exclusive for all-day events)",
  attendees: "Attendees",
  add_label_ids: "Add labels",
  remove_label_ids: "Remove labels",
  date: "Date",
  dateTime: "Date and time",
  timeZone: "Time zone",
  email: "Email",
};

function display(value: unknown): string {
  if (Array.isArray(value)) return value.map(display).join("\n");
  if (value && typeof value === "object")
    return Object.entries(value)
      .filter(([, nested]) => nested !== undefined && nested !== null)
      .map(([key, nested]) => `${labels[key] ?? key}: ${display(nested)}`)
      .join("\n");
  return String(value ?? "");
}

export function GoogleWorkspaceActionCard({
  action,
  busy = false,
  onDecision,
}: {
  action: GoogleWorkspaceActionReview;
  busy?: boolean;
  onDecision: (decision: "approve" | "reject") => void;
}) {
  const name = googleActionNames[action.proposal.tool] ?? "Google action";
  const [renderedAt] = useState(() => Date.now());
  const expired = Date.parse(action.expiresAt) <= renderedAt;
  return (
    <GlassCardUI>
      <article
        aria-label={`${name} approval`}
        className="space-y-3 p-3 text-left"
      >
        <div>
          <h4 className="text-sm font-medium">{name}</h4>
          <p className="mt-1 break-all text-xs text-muted-foreground">
            Account: {action.proposal.accountEmail}
          </p>
          <p className="text-xs text-muted-foreground">
            Status: {action.status}
            {action.status === "pending"
              ? ` · Expires ${new Date(action.expiresAt).toLocaleTimeString()}`
              : ""}
          </p>
        </div>
        {action.provider === "google-calendar" && (
          <p className="text-sm">
            Google will notify attendees of this change. Deleting an event
            sends cancellation notices.
          </p>
        )}
        {action.proposal.tool === "gmail_propose_delete_draft" && (
          <p className="text-sm">
            This deletes the draft. Review its contents before approving.
          </p>
        )}
        <dl className="space-y-2 text-sm">
          {Object.entries(action.proposal.args).map(([key, value]) => (
            <div key={key}>
              <dt className="font-medium">{labels[key] ?? key}</dt>
              <dd className="whitespace-pre-wrap break-words">
                {display(value)}
              </dd>
            </div>
          ))}
        </dl>
        {action.proposal.before !== undefined && (
          <details>
            <summary className="cursor-pointer text-sm">
              Current item before this change
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
              {display(action.proposal.before)}
            </pre>
          </details>
        )}
        {action.resultMessage && (
          <p className="text-sm" role="status">
            {action.resultMessage}
          </p>
        )}
        {action.status === "executing" && (
          <p className="text-xs">
            Execution has started. If this status persists, check Google before
            requesting another action; Mike will not run this approval again.
          </p>
        )}
        {action.status === "pending" && (
          <div className="flex flex-wrap gap-2">
            <PillButtonUI
              tone="blue"
              disabled={busy || expired}
              onClick={() => onDecision("approve")}
            >
              Approve {name.toLowerCase()}
            </PillButtonUI>
            <PillButtonUI
              tone="white"
              disabled={busy}
              onClick={() => onDecision("reject")}
            >
              Reject
            </PillButtonUI>
          </div>
        )}
      </article>
    </GlassCardUI>
  );
}

export function InlineGoogleWorkspaceAction({ actionId }: { actionId: string }) {
  const [action, setAction] = useState<GoogleWorkspaceActionReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(false);
  const retryRef = useRef<(() => Promise<void>) | null>(null);

  const refresh = useCallback(async () => {
    const result = await listGoogleWorkspaceActions();
    const next = result.actions.find((candidate) => candidate.id === actionId);
    if (!next) throw new Error("The Google action is no longer available.");
    setAction(next);
  }, [actionId]);

  useEffect(() => {
    let mounted = true;
    listGoogleWorkspaceActions()
      .then((result) => {
        if (!mounted) return;
        const next = result.actions.find((candidate) => candidate.id === actionId);
        if (next) setAction(next);
        else setError("This Google action is no longer available.");
      })
      .catch(() => {
        if (mounted) setError("Could not load this Google action.");
      });
    return () => {
      mounted = false;
    };
  }, [actionId]);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    const run = async () => {
      const result = await decideGoogleWorkspaceAction(actionId, decision);
      await refresh();
      if (result && result.status !== "succeeded") setError(result.message);
    };
    try {
      await run();
    } catch (cause) {
      if (isMfaRequiredError(cause)) {
        retryRef.current = run;
        setMfa(true);
      } else {
        setError(
          userFacingApiError(
            cause,
            "Could not complete this decision. Refresh and check its status before retrying.",
          ),
        );
        try {
          await refresh();
        } catch {
          // Preserve the original decision error.
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (!action)
    return (
      <div className="mt-2 text-sm" role={error ? "alert" : "status"}>
        {error ?? "Loading Google action…"}
      </div>
    );

  return (
    <div className="mt-2 space-y-2">
      <GoogleWorkspaceActionCard
        action={action}
        busy={busy}
        onDecision={(decision) => void decide(decision)}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <MfaVerificationPopup
        open={mfa}
        onCancel={() => {
          setMfa(false);
          retryRef.current = null;
        }}
        onVerified={() => {
          setMfa(false);
          const retry = retryRef.current;
          retryRef.current = null;
          if (retry)
            void retry().catch((cause) =>
              setError(
                userFacingApiError(
                  cause,
                  "Could not complete the verified action.",
                ),
              ),
            );
        }}
      />
    </div>
  );
}
