import React from "react";
import { LoaderCircle } from "lucide-react";
import { Markdown } from "../../../shared/chat/Markdown";
import { projectRedlineStream } from "../../lib/redline";
import type { StreamingRedlineEdit } from "../../lib/redline";
import type {
  WordDocumentReadEvent,
  WordReasoningEvent,
  WordThinkingEvent,
} from "../../types";
import { PillButtonUI as PillButton } from "@mike/pill-button-ui";
import { EditCard } from "./EditCard";
import { PreResponseWrapper } from "./PreResponseWrapper";
import { EditCardsSection } from "./message/EditCardsSection";
import {
  DocReadBlock,
  EventBlock,
  ReasoningBlock,
} from "./message/EventBlocks";
import { ResponseStatus, type StatusState } from "./message/ResponseStatus";
import {
  assistantContent,
  assistantError,
  isWordContentEvent,
  isWordDocumentReadEvent,
  isWordEditBlockEvent,
  isWordEditReferenceEvent,
  isWordReasoningEvent,
  isWordThinkingEvent,
} from "../../lib/wordChatEvents";
import { getEditKey } from "../../lib/wordTrackedEditKeys";
import {
  decodeCitationHref,
  projectCitationMarkdown,
} from "../../lib/citations";
import type {
  EditCardStatus,
  EditDecision,
  EditRuntimeState,
  WordAssistantMessage as WordAssistantTurn,
} from "../../lib/wordChatTypes";

interface AssistantMessageProps {
  message: WordAssistantTurn;
  isStreaming: boolean;
  minHeight?: React.CSSProperties["minHeight"];
  editStateByKey: Readonly<Record<string, EditRuntimeState>>;
  onApplyEdit: (key: string) => void;
  onViewEdit: (key: string) => void;
  onResolveEdit: (key: string, decision: EditDecision) => void;
  onResolveAll: (keys: string[], decision: EditDecision) => void;
  /** Conflicted card: accept the occupying revisions, then apply the edit. */
  onAcceptAndApplyEdit: (key: string) => void;
  /** Scrolls Word to a cited document passage and selects it. */
  onLocateCitation: (text: string) => void;
}

type EventGroup =
  | {
      kind: "pre";
      events: (
        | WordThinkingEvent
        | WordReasoningEvent
        | WordDocumentReadEvent
      )[];
      indices: number[];
    }
  | { kind: "prose"; text: string; key: string }
  | { kind: "edits"; blockIndexes: number[]; key: string };

function normalizedEditToStreaming(
  edit: NonNullable<WordAssistantTurn["edits"]>[number],
): StreamingRedlineEdit {
  return {
    blockIndex: edit.blockIndex,
    original: edit.originalText,
    replacement: edit.replacementText,
    ...(edit.formats.length > 0
      ? { format: edit.formats as StreamingRedlineEdit["format"] }
      : {}),
    ...(edit.occurrence ? { occurrence: edit.occurrence } : {}),
    ...(edit.reason ? { reason: edit.reason } : {}),
    sealed: true,
  };
}

function persistedEditStatus(
  edit: NonNullable<WordAssistantTurn["edits"]>[number] | undefined,
): EditCardStatus | undefined {
  if (!edit) return undefined;
  if (edit.resolutionStatus) return edit.resolutionStatus;
  if (edit.applyStatus === "proposed") return "validating";
  // A skipped edit is persisted as applied (the document carries it) but
  // has no anchor to restore, so it keeps its own card, not "restoring".
  if (edit.errorCode === "already-applied") return "already-applied";
  if (edit.applyStatus === "applied") return "restoring";
  if (edit.applyStatus === "unmanaged") return "unmanaged";
  // Checked before the generic "error" fallback below: a reopened pane must
  // not turn "Mike couldn't confirm this" into "couldn't apply this".
  if (edit.errorCode === "unverified") return "unverified";
  if (edit.errorCode === "ambiguous") return "ambiguous";
  if (edit.errorCode === "unsearchable") return "unsearchable";
  if (edit.errorCode === "pre-existing-revisions") return "conflicted";
  if (edit.errorCode === "not-found") return "skipped";
  return "error";
}

function AssistantMessageImpl({
  message,
  isStreaming,
  minHeight,
  editStateByKey,
  onApplyEdit,
  onViewEdit,
  onResolveEdit,
  onResolveAll,
  onAcceptAndApplyEdit,
  onLocateCitation,
}: AssistantMessageProps): React.ReactElement {
  // Citation chips render as reserved-fragment links; one delegated handler
  // on each prose block routes their clicks to Word instead of navigation.
  const handleCitationClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const citationControl = target.closest?.("[data-mike-citation]");
      const href =
        citationControl?.getAttribute("data-citation-href") ??
        citationControl?.getAttribute("href");
      if (!href) return;
      const quote = decodeCitationHref(href);
      if (quote === null) return;
      event.preventDefault();
      onLocateCitation(quote);
    },
    [onLocateCitation],
  );
  const content = React.useMemo(() => assistantContent(message), [message]);
  const error = assistantError(message);
  const responseStatus: StatusState = error
    ? "error"
    : isStreaming
      ? "active"
      : null;
  // Re-projecting the full answer is linear in its length; memoize so edit
  // runtime updates (editStateByKey) do not re-parse an unchanged transcript.
  const streamProjection = React.useMemo(
    () => projectRedlineStream(content),
    [content],
  );
  const edits: StreamingRedlineEdit[] = React.useMemo(
    () =>
      message.edits && message.edits.length > 0
        ? message.edits.map(normalizedEditToStreaming)
        : streamProjection.edits,
    [streamProjection.edits, message.edits],
  );
  const editRows = edits.map((edit, editIndex) => {
    const key = getEditKey(message.id, edit.blockIndex);
    const runtime = editStateByKey[key];
    const stored = message.edits?.find(
      (candidate) => candidate.blockIndex === edit.blockIndex,
    );
    const status: EditCardStatus =
      runtime?.status ??
      persistedEditStatus(stored) ??
      (message.live ? (edit.sealed ? "applying" : "receiving") : "historical");
    return { edit, editIndex, key, runtime, status };
  });
  const hasUnfinishedEdit = editRows.some(
    ({ status }) =>
      status === "receiving" ||
      status === "validating" ||
      status === "applying" ||
      status === "applying-approved" ||
      status === "restoring",
  );
  const anyEditBusy = editRows.some(({ runtime }) => runtime?.busy);
  // Holding the answer text until edits settle exists for edits embedded IN
  // that text: a streamed <EDITS> block would otherwise render half-parsed
  // above its own summary. Tool-proposed edits live outside the prose
  // entirely, so keying the hold on the merged row list would blank the
  // model's preamble for the whole time a batch is validating or applying.
  const hasProjectedEdits = streamProjection.edits.length > 0;
  const summaryReady =
    !hasProjectedEdits || (!isStreaming && !hasUnfinishedEdit);

  const editById = React.useMemo(
    () => new Map((message.edits ?? []).map((edit) => [edit.id, edit])),
    [message.edits],
  );
  const groups = React.useMemo(() => {
    const result: EventGroup[] = [];
    let pre: Extract<EventGroup, { kind: "pre" }> | null = null;
    let blockOffset = 0;
    const flushPre = (): void => {
      if (pre) result.push(pre);
      pre = null;
    };
    const pushEdit = (blockIndex: number, key: string): void => {
      flushPre();
      const last = result[result.length - 1];
      if (last?.kind === "edits") {
        last.blockIndexes.push(blockIndex);
      } else {
        result.push({ kind: "edits", blockIndexes: [blockIndex], key });
      }
    };

    message.events.forEach((event, eventIndex) => {
      if (isWordContentEvent(event)) {
        flushPre();
        const projection = projectRedlineStream(event.text);
        for (const [segmentIndex, segment] of projection.segments.entries()) {
          if (segment.kind === "prose") {
            result.push({
              kind: "prose",
              text: segment.text,
              key: `content-${event.key ?? eventIndex}-${segmentIndex}`,
            });
          } else {
            pushEdit(
              blockOffset + segment.edit.blockIndex,
              `edit-${event.key ?? eventIndex}-${segmentIndex}`,
            );
          }
        }
        blockOffset += projection.blockCount;
        return;
      }
      if (isWordEditReferenceEvent(event)) {
        const edit = editById.get(event.editId);
        if (edit) pushEdit(edit.blockIndex, `edit-ref-${event.editId}`);
        return;
      }
      // A tool-proposed edit places itself by block index: the live turn
      // knows the ordinal the moment the call is forwarded, long before the
      // canonical row (and its id) exists.
      if (isWordEditBlockEvent(event)) {
        pushEdit(event.blockIndex, `edit-block-${event.blockIndex}`);
        return;
      }
      if (
        !isWordThinkingEvent(event) &&
        !isWordReasoningEvent(event) &&
        !isWordDocumentReadEvent(event)
      ) {
        return;
      }
      if (!pre) pre = { kind: "pre", events: [], indices: [] };
      pre.events.push(event);
      pre.indices.push(eventIndex);
    });
    flushPre();
    return result;
  }, [editById, isStreaming, message.events]);
  const firstEditGroupIndex = groups.findIndex(
    (group) => group.kind === "edits",
  );
  const hasContentAfter = (groupIndex: number): boolean =>
    groups
      .slice(groupIndex + 1)
      .some((group) => group.kind === "prose" && group.text.length > 0);

  const renderEditGroup = (blockIndexes: number[]): React.ReactNode => {
    const rows = blockIndexes
      .map((blockIndex) =>
        editRows.find((row) => row.edit.blockIndex === blockIndex),
      )
      .filter((row): row is (typeof editRows)[number] => !!row)
      .filter(
        ({ status }) =>
          status !== "receiving" &&
          status !== "validating" &&
          status !== "applying" &&
          status !== "restoring",
      );
    if (rows.length === 0) return null;
    const pendingRows = rows.filter(({ status }) => status === "pending");
    const pendingCount = pendingRows.length;
    const groupBusyAction =
      pendingRows.length > 0 &&
      pendingRows.every(
        ({ runtime }) =>
          runtime?.busy &&
          runtime.busyAction === pendingRows[0]?.runtime?.busyAction,
      )
        ? pendingRows[0]?.runtime?.busyAction
        : undefined;
    const groupBusyLabel = (action: "accept" | "reject") => (
      <>
        <LoaderCircle aria-hidden="true" className="h-3 w-3 animate-spin" />
        <span>{action === "accept" ? "Accepting..." : "Rejecting..."}</span>
      </>
    );
    return (
      <EditCardsSection
        summary={`${rows.length} tracked ${rows.length === 1 ? "change" : "changes"}`}
        actions={
          pendingCount > 0 ? (
            <>
              <PillButton
                tone="blue"
                onClick={() =>
                  onResolveAll(
                    rows.map(({ key }) => key),
                    "accept",
                  )
                }
                disabled={hasUnfinishedEdit || anyEditBusy}
              >
                {groupBusyAction === "accept"
                  ? groupBusyLabel("accept")
                  : "Accept all"}
              </PillButton>
              <PillButton
                tone="white"
                onClick={() =>
                  onResolveAll(
                    rows.map(({ key }) => key),
                    "reject",
                  )
                }
                disabled={hasUnfinishedEdit || anyEditBusy}
              >
                {groupBusyAction === "reject"
                  ? groupBusyLabel("reject")
                  : "Reject all"}
              </PillButton>
            </>
          ) : undefined
        }
      >
        {rows.map(({ edit, editIndex, key, runtime, status }) => (
          <EditCard
            key={key}
            edit={edit}
            changeNumber={editIndex + 1}
            status={status}
            matches={runtime?.matches}
            appliedMatches={runtime?.appliedMatches}
            locationHint={runtime?.locationHint}
            error={runtime?.viewError ?? runtime?.error}
            disabled={!!runtime?.busy}
            busyAction={runtime?.busy ? runtime.busyAction : undefined}
            onView={
              status === "ready" ||
              status === "pending" ||
              status === "view-only" ||
              status === "conflicted"
                ? () => onViewEdit(key)
                : undefined
            }
            onApply={status === "ready" ? () => onApplyEdit(key) : undefined}
            onAccept={
              status === "pending"
                ? () => onResolveEdit(key, "accept")
                : undefined
            }
            onReject={
              status === "pending"
                ? () => onResolveEdit(key, "reject")
                : undefined
            }
            onAcceptAndApply={
              status === "conflicted"
                ? () => onAcceptAndApplyEdit(key)
                : undefined
            }
          />
        ))}
      </EditCardsSection>
    );
  };

  return (
    <div
      className="w-full shrink-0"
      style={minHeight === undefined ? undefined : { minHeight }}
      data-assistant-message-id={message.id}
    >
      <ResponseStatus status={responseStatus} />
      <div className="mt-2 flex flex-col gap-3">
        {groups.map((group, groupIndex) => {
          if (group.kind === "prose") {
            const holdForEdit =
              hasProjectedEdits &&
              firstEditGroupIndex >= 0 &&
              groupIndex >= firstEditGroupIndex &&
              !summaryReady;
            return (
              <React.Fragment key={group.key}>
                {group.text && !holdForEdit && (
                  <div
                    className="font-serif text-base leading-7 text-gray-900"
                    onClick={handleCitationClick}
                  >
                    <Markdown className="text-base leading-7">
                      {projectCitationMarkdown(group.text, message.citations)}
                    </Markdown>
                  </div>
                )}
              </React.Fragment>
            );
          }

          if (group.kind === "edits") {
            return (
              <React.Fragment key={group.key}>
                {renderEditGroup(group.blockIndexes)}
              </React.Fragment>
            );
          }

          const groupIsStreaming = group.events.some(
            (event) =>
              isWordThinkingEvent(event) ||
              (isWordReasoningEvent(event) && !!event.isStreaming) ||
              (isWordDocumentReadEvent(event) && event.status === "reading"),
          );
          return (
            <React.Fragment
              key={`pre-${group.events[0]?.key ?? group.indices[0] ?? groupIndex}`}
            >
              <PreResponseWrapper
                stepCount={group.events.length}
                shouldMinimize={hasContentAfter(groupIndex) || !!error}
                isStreaming={groupIsStreaming}
              >
                {group.events.map((event, eventIndex) => {
                  const showConnector = eventIndex < group.events.length - 1;
                  if (isWordReasoningEvent(event)) {
                    return (
                      <ReasoningBlock
                        key={event.key ?? group.indices[eventIndex]}
                        text={event.text}
                        isStreaming={!!event.isStreaming}
                        showConnector={showConnector}
                      />
                    );
                  }
                  if (isWordThinkingEvent(event)) {
                    return (
                      <EventBlock
                        key={event.key ?? group.indices[eventIndex]}
                        showConnector={showConnector}
                        isStreaming
                        dotColor="gray"
                      >
                        Thinking...
                      </EventBlock>
                    );
                  }
                  if (isWordDocumentReadEvent(event)) {
                    return (
                      <DocReadBlock
                        key={event.key ?? group.indices[eventIndex]}
                        filename={event.filename}
                        isStreaming={event.status === "reading"}
                        showConnector={showConnector}
                      />
                    );
                  }
                  return null;
                })}
              </PreResponseWrapper>
            </React.Fragment>
          );
        })}
        {error && (
          <p
            role="alert"
            className="font-serif text-base leading-7 text-red-600"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// Streaming commits replace only the live assistant row's message object;
// memoizing here keeps every settled row (and its full Markdown re-parse)
// out of the per-chunk render entirely.
export const AssistantMessage = React.memo(AssistantMessageImpl);
