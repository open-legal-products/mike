import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportWordFailure } from "../lib/errorReporting";
import {
  releaseTrackedEdits,
  revealProposedEdit,
  resolveTrackedEdit,
  resolveTrackedEdits,
  restoreTrackedEdits,
  revealPersistedTrackedEdit,
  revealTrackedEdit,
  validateTrackedEdit,
  useWordDoc,
} from "./useWordDoc";
import type { TrackedEditHandle } from "./useWordDoc";
import type { Message as SavedMessage, WordDocumentEdit } from "../types";
import { projectRedlineStream } from "../lib/redline";
import type { RedlineEdit, StreamingRedlineEdit } from "../lib/redline";

/**
 * Shape a sealed streamed block for `applyTrackedEdits`. Returns null for a
 * block that carries neither a replacement nor a usable format list — such a
 * block is never safe to apply.
 */
function toRedlineEdit(edit: StreamingRedlineEdit): RedlineEdit | null {
  const isFormatEdit = !!edit.format && edit.format.length > 0;
  if (edit.replacement === undefined && !isFormatEdit) return null;
  return {
    original: edit.original,
    replacement: edit.replacement ?? "",
    ...(isFormatEdit ? { format: edit.format } : {}),
    ...(edit.occurrence ? { occurrence: edit.occurrence } : {}),
    ...(edit.reason ? { reason: edit.reason } : {}),
  };
}

function storedEditToRedlineEdit(edit: WordDocumentEdit): RedlineEdit {
  return {
    original: edit.originalText,
    replacement: edit.replacementText,
    ...(edit.formats.length > 0
      ? { format: edit.formats as RedlineEdit["format"] }
      : {}),
    ...(edit.occurrence ? { occurrence: edit.occurrence } : {}),
    ...(edit.reason ? { reason: edit.reason } : {}),
  };
}

type TrackedEditApplyOutcome = Awaited<
  ReturnType<ReturnType<typeof useWordDoc>["applyTrackedEdits"]>
>["edits"][number];

function editFailureState(result: {
  status: string;
  reason?: string;
  error?: string;
}): Pick<EditRuntimeState, "status" | "error"> {
  if (result.status === "error") {
    return { status: "error", error: result.error };
  }
  if (result.reason === "ambiguous") {
    return { status: "ambiguous", error: result.error };
  }
  if (result.status === "not-found") {
    return {
      status: "skipped",
      error: "Skipped — the source text could not be found in the document.",
    };
  }
  if (result.reason === "unsearchable") {
    return {
      status: "unsearchable",
      error: "Skipped — this passage cannot be safely located in the document.",
    };
  }
  if (result.reason === "pre-existing-revisions") {
    return {
      status: "conflicted",
      error: result.error,
    };
  }
  return { status: "skipped", error: result.error };
}
import type {
  EditDecision,
  EditRuntimeState,
  PersistWordDocumentEdit,
  PersistedWordEditPatch,
  UpdatePersistedWordDocumentEdit,
  WordEditStreamController,
  WordToolEditItem,
  WordToolEditOutcome,
  WordTrackedEditsController,
} from "../lib/wordChatTypes";
import type { WordEditApplyMode } from "../lib/wordChatSettings";
import { getEditKey, parseEditKey } from "../lib/wordTrackedEditKeys";
import { listWordEditAnchorIds } from "../lib/wordEditAnchors";

export function useWordTrackedEdits({
  sessionKey,
  initialMessages,
  applyMode = "approval",
  onPersistEdit,
  onUpdatePersistedEdit,
}: {
  sessionKey: number;
  initialMessages: SavedMessage[];
  applyMode?: WordEditApplyMode;
  onPersistEdit?: PersistWordDocumentEdit;
  onUpdatePersistedEdit?: UpdatePersistedWordDocumentEdit;
}): WordTrackedEditsController {
  const [editStateByKey, setEditStateByKey] = useState<
    Record<string, EditRuntimeState>
  >({});
  // Synchronous mirror of the rendered map. A tool call must report each
  // card's SETTLED status back to the model the instant its job resolves,
  // and React state is not readable that soon; every write goes through
  // commitEditState so the two can never disagree.
  const editStateRef = useRef<Record<string, EditRuntimeState>>({});
  const mountedRef = useRef(true);
  const sessionGenerationRef = useRef(0);
  const scheduledEditKeysRef = useRef(new Set<string>());
  const editApplyJobsRef = useRef(new Map<string, Promise<void>>());
  // One card can own several Word handles: a replace-all edit retains one
  // per applied occurrence, resolved together.
  const editHandlesRef = useRef(new Map<string, TrackedEditHandle[]>());
  // Review-mode proposals remain non-mutating until the user clicks Apply.
  const readyEditsRef = useRef(
    new Map<string, { edit: RedlineEdit; persistent: boolean }>(),
  );
  // Card key → the stable edit ID whose document bookmark backs "View" after
  // a reload (a replace-all card's first restored pass, else the key itself).
  const persistentViewEditKeysRef = useRef(new Map<string, string>());
  const resolvingEditKeysRef = useRef(new Set<string>());
  const persistEditRef = useRef(onPersistEdit);
  persistEditRef.current = onPersistEdit;
  const updatePersistedEditRef = useRef(onUpdatePersistedEdit);
  updatePersistedEditRef.current = onUpdatePersistedEdit;
  const persistedEditIdsRef = useRef(new Map<string, string>());
  const editPersistenceJobsRef = useRef(new Map<string, Promise<void>>());
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Read at apply time so a mid-stream toggle governs only edits that have
  // not been scheduled yet; already-applied cards keep their lifecycle.
  const applyModeRef = useRef(applyMode);
  applyModeRef.current = applyMode;
  const { applyTrackedEdits, acceptPendingRevisionsForEdit } = useWordDoc();
  // Conflicted cards keep their full apply arguments so "Accept & apply"
  // can accept the occupying revisions and rerun the same lifecycle.
  const conflictedRetryRef = useRef(
    new Map<
      string,
      {
        edit: RedlineEdit;
        persistent: boolean;
      }
    >(),
  );

  const commitEditState = useCallback(
    (next: Record<string, EditRuntimeState>): void => {
      editStateRef.current = next;
      setEditStateByKey(next);
    },
    [],
  );

  const setEditRuntimeState = useCallback(
    (key: string, patch: Partial<EditRuntimeState>): void => {
      const previous = editStateRef.current[key];
      commitEditState({
        ...editStateRef.current,
        [key]: {
          ...previous,
          ...patch,
          status: patch.status ?? previous?.status ?? "receiving",
        },
      });
    },
    [commitEditState],
  );

  const updatePersistedEdit = useCallback(
    (key: string, patch: PersistedWordEditPatch): Promise<void> => {
      const parsed = parseEditKey(key);
      if (!parsed || !updatePersistedEditRef.current) {
        return Promise.resolve();
      }
      const update = updatePersistedEditRef.current;
      const next = persistenceQueueRef.current
        .catch(() => undefined)
        .then(() => update(parsed.messageId, parsed.blockIndex, patch));
      persistenceQueueRef.current = next.catch((error: unknown) => {
        console.warn("[word-addin] failed to persist Word edit state", error);
      });
      return persistenceQueueRef.current;
    },
    [],
  );

  const ensurePersistedEdit = useCallback(
    (
      key: string,
      edit: RedlineEdit,
      mode: WordEditApplyMode,
    ): Promise<void> => {
      if (persistedEditIdsRef.current.has(key)) return Promise.resolve();
      const existing = editPersistenceJobsRef.current.get(key);
      if (existing) return existing;
      const parsed = parseEditKey(key);
      const persist = persistEditRef.current;
      if (!parsed || !persist) return Promise.resolve();
      const job = persist(parsed.messageId, parsed.blockIndex, edit, mode)
        .then((stored) => {
          persistedEditIdsRef.current.set(key, stored.id);
        })
        .finally(() => {
          editPersistenceJobsRef.current.delete(key);
        });
      editPersistenceJobsRef.current.set(key, job);
      return job;
    },
    [],
  );

  const recordTerminalDecision = useCallback(
    async (key: string, status: "accepted" | "rejected"): Promise<void> => {
      await updatePersistedEdit(key, { resolution_status: status });
      setEditRuntimeState(key, {
        status,
        busy: false,
        busyAction: undefined,
        error: undefined,
      });
    },
    [setEditRuntimeState, updatePersistedEdit],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionGenerationRef.current += 1;
      const handles = [...editHandlesRef.current.values()].flat();
      editHandlesRef.current.clear();
      readyEditsRef.current.clear();
      editApplyJobsRef.current.clear();
      editPersistenceJobsRef.current.clear();
      persistedEditIdsRef.current.clear();
      persistentViewEditKeysRef.current.clear();
      resolvingEditKeysRef.current.clear();
      conflictedRetryRef.current.clear();
      if (handles.length > 0) void releaseTrackedEdits(handles);
    };
  }, []);

  useEffect(() => {
    sessionGenerationRef.current += 1;
    const generation = sessionGenerationRef.current;
    const staleHandles = [...editHandlesRef.current.values()].flat();
    editHandlesRef.current.clear();
    readyEditsRef.current.clear();
    if (staleHandles.length > 0) void releaseTrackedEdits(staleHandles);
    scheduledEditKeysRef.current.clear();
    editApplyJobsRef.current.clear();
    editPersistenceJobsRef.current.clear();
    persistedEditIdsRef.current.clear();
    persistentViewEditKeysRef.current.clear();
    resolvingEditKeysRef.current.clear();
    conflictedRetryRef.current.clear();
    commitEditState({});

    const descriptors: {
      cardKey: string;
      stableEditId: string;
      edit: RedlineEdit;
    }[] = [];
    const proposedDescriptors: { cardKey: string; edit: RedlineEdit }[] = [];
    const durableStates: Record<string, EditRuntimeState> = {};
    for (const message of initialMessages) {
      if (message.role !== "assistant" || !message.id) continue;
      if (message.edits && message.edits.length > 0) {
        for (const storedEdit of message.edits) {
          const cardKey = getEditKey(message.id, storedEdit.blockIndex);
          persistedEditIdsRef.current.set(cardKey, storedEdit.id);
          if (storedEdit.resolutionStatus) {
            durableStates[cardKey] = {
              status: storedEdit.resolutionStatus,
              busy: false,
            };
            continue;
          }
          const edit = storedEditToRedlineEdit(storedEdit);
          if (
            storedEdit.applyStatus === "failed" ||
            storedEdit.applyStatus === "unmanaged"
          ) {
            durableStates[cardKey] = {
              status:
                storedEdit.applyStatus === "unmanaged"
                  ? "unmanaged"
                  : storedEdit.errorCode === "ambiguous"
                    ? "ambiguous"
                    : storedEdit.errorCode === "unsearchable"
                      ? "unsearchable"
                      : storedEdit.errorCode === "pre-existing-revisions"
                        ? "conflicted"
                        : storedEdit.errorCode === "not-found"
                          ? "skipped"
                          : "error",
              busy: false,
              error: storedEdit.errorMessage,
              matches: storedEdit.matchedOccurrences,
              appliedMatches: storedEdit.appliedOccurrences,
            };
            if (storedEdit.errorCode === "pre-existing-revisions") {
              conflictedRetryRef.current.set(cardKey, {
                edit,
                persistent: true,
              });
            }
            continue;
          }
          if (storedEdit.applyStatus === "proposed") {
            proposedDescriptors.push({ cardKey, edit });
            continue;
          }
          if (edit.occurrence === "all") {
            let passIds: string[] = [];
            try {
              passIds = listWordEditAnchorIds(`${cardKey}#`);
            } catch {
              passIds = [];
            }
            if (passIds.length === 0) {
              passIds = Array.from(
                { length: 8 },
                (_, index) => `${cardKey}#${index}`,
              );
            }
            for (const stableEditId of passIds) {
              descriptors.push({ cardKey, stableEditId, edit });
            }
          } else {
            descriptors.push({ cardKey, stableEditId: cardKey, edit });
          }
        }
        continue;
      }
    }
    const initialStates: Record<string, EditRuntimeState> = {
      ...durableStates,
    };
    for (const { cardKey } of descriptors) {
      initialStates[cardKey] = { status: "restoring", busy: true };
    }
    for (const { cardKey } of proposedDescriptors) {
      initialStates[cardKey] = { status: "validating", busy: true };
    }
    commitEditState(initialStates);

    if (proposedDescriptors.length > 0) {
      void (async () => {
        // A stored "proposed" row means the pane never RECORDED an apply —
        // but a turn that died mid-apply (a cancelled stream, a client tool
        // call that timed out, a failed status write) leaves the tracked
        // change in the document with the row still saying "proposed". Ask
        // the document before believing the row: re-validating such an edit
        // finds its own revision, reports "pre-existing-revisions", and
        // offers "Accept & apply" — which applies it a second time.
        const probes = await restoreTrackedEdits(
          proposedDescriptors.map(({ cardKey, edit }) => ({
            stableEditId: cardKey,
            edit,
          })),
        );
        if (
          !mountedRef.current ||
          generation !== sessionGenerationRef.current
        ) {
          const orphaned = probes.flatMap((probe) =>
            probe.handle ? [probe.handle] : [],
          );
          if (orphaned.length > 0) await releaseTrackedEdits(orphaned);
          return;
        }
        const unapplied: { cardKey: string; edit: RedlineEdit }[] = [];
        probes.forEach((probe, probeIndex) => {
          const descriptor = proposedDescriptors[probeIndex];
          if (!descriptor) return;
          const { cardKey } = descriptor;
          if (probe.status === "restored" && probe.handle) {
            editHandlesRef.current.set(cardKey, [probe.handle]);
            persistentViewEditKeysRef.current.set(cardKey, cardKey);
            setEditRuntimeState(cardKey, {
              status: "pending",
              busy: false,
              error: undefined,
            });
            // Correct the record too, so the next reload does not repeat the
            // probe and no other reader is told this change is unapplied.
            void updatePersistedEdit(cardKey, { apply_status: "applied" });
            return;
          }
          if (probe.status === "view-only") {
            persistentViewEditKeysRef.current.set(cardKey, cardKey);
            setEditRuntimeState(cardKey, {
              status: "view-only",
              busy: false,
              error: undefined,
            });
            void updatePersistedEdit(cardKey, { apply_status: "applied" });
            return;
          }
          unapplied.push(descriptor);
        });
        if (unapplied.length === 0) return;

        const results = await Promise.all(
          unapplied.map(async ({ cardKey, edit }) => ({
            cardKey,
            edit,
            result: await validateTrackedEdit(edit),
          })),
        );
        if (
          !mountedRef.current ||
          generation !== sessionGenerationRef.current
        ) {
          return;
        }
        for (const { cardKey, edit, result } of results) {
          if (result.status === "ready") {
            readyEditsRef.current.set(cardKey, { edit, persistent: true });
            setEditRuntimeState(cardKey, {
              status: "ready",
              matches: result.matches,
              busy: false,
              error: undefined,
            });
          } else {
            if (result.reason === "pre-existing-revisions") {
              conflictedRetryRef.current.set(cardKey, {
                edit,
                persistent: true,
              });
            }
            setEditRuntimeState(cardKey, {
              ...editFailureState(result),
              matches: result.matches,
              busy: false,
            });
          }
        }
      })().catch((error: unknown) => {
        if (!mountedRef.current || generation !== sessionGenerationRef.current) {
          return;
        }
        for (const { cardKey } of proposedDescriptors) {
          setEditRuntimeState(cardKey, {
            status: "error",
            busy: false,
            error:
              error instanceof Error
                ? error.message
                : "Word couldn't check whether this change can be applied.",
          });
        }
      });
    }
    if (descriptors.length === 0) return;

    // One batched restore: every bookmark lookup shares a single Word.run
    // behind the global mutation queue, instead of ~4 serialized syncs per
    // stored edit. The batch keeps per-edit failure isolation internally.
    void (async () => {
      const results = await restoreTrackedEdits(
        descriptors.map(({ stableEditId, edit }) => ({ stableEditId, edit })),
      );
      if (!mountedRef.current || generation !== sessionGenerationRef.current) {
        const staleHandles = results.flatMap((result) =>
          result.handle ? [result.handle] : [],
        );
        if (staleHandles.length > 0) await releaseTrackedEdits(staleHandles);
        return;
      }

      // Aggregate per card: a replace-all card owns several pass results,
      // and any restored pass keeps the whole card actionable.
      interface CardRestoreBucket {
        handles: TrackedEditHandle[];
        viewId?: string;
        anyViewOnly: boolean;
        firstError?: string;
      }
      const byCard = new Map<string, CardRestoreBucket>();
      results.forEach((result, resultIndex) => {
        const descriptor = descriptors[resultIndex];
        if (!descriptor) return;
        const bucket = byCard.get(descriptor.cardKey) ?? {
          handles: [],
          anyViewOnly: false,
        };
        if (result.status === "restored" && result.handle) {
          bucket.handles.push(result.handle);
          bucket.viewId ??= descriptor.stableEditId;
        } else if (result.status === "view-only") {
          bucket.anyViewOnly = true;
          bucket.viewId ??= descriptor.stableEditId;
        }
        if (result.error) bucket.firstError ??= result.error;
        byCard.set(descriptor.cardKey, bucket);
      });

      for (const [cardKey, bucket] of byCard) {
        if (bucket.handles.length > 0) {
          editHandlesRef.current.set(cardKey, bucket.handles);
          persistentViewEditKeysRef.current.set(
            cardKey,
            bucket.viewId ?? cardKey,
          );
          setEditRuntimeState(cardKey, {
            status: "pending",
            busy: false,
            error: undefined,
          });
          continue;
        }
        if (bucket.anyViewOnly) {
          persistentViewEditKeysRef.current.set(
            cardKey,
            bucket.viewId ?? cardKey,
          );
          setEditRuntimeState(cardKey, {
            status: "view-only",
            busy: false,
            error: undefined,
          });
          continue;
        }
        setEditRuntimeState(cardKey, {
          status: "historical",
          busy: false,
          error: bucket.firstError,
        });
      }
    })();
    // sessionKey is the explicit boundary for historical restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const beginApplyingEdit = useCallback(
    (
      key: string,
      edit: RedlineEdit,
      persistent: boolean,
      keepCardVisible = false,
      mode: WordEditApplyMode = applyModeRef.current,
    ): void => {
      readyEditsRef.current.delete(key);
      conflictedRetryRef.current.delete(key);
      setEditRuntimeState(key, {
        status: keepCardVisible ? "applying-approved" : "applying",
        busy: true,
        busyAction: "apply",
      });
      const generation = sessionGenerationRef.current;

      const replaceAll = edit.occurrence === "all";
      // Runaway guard only: a real replace-all finishes when a pass reports
      // zero remaining revision-free occurrences.
      const MAX_REPLACE_ALL_PASSES = 50;

      const job = (async (): Promise<void> => {
        await ensurePersistedEdit(key, edit, mode);
        const abandoned = (): boolean =>
          generation !== sessionGenerationRef.current || !mountedRef.current;

        // A replace-all edit applies one occurrence per call (last match
        // first — see applyTrackedEdits) and every pass retains its own
        // handle; a single edit runs exactly one pass.
        const handles: TrackedEditHandle[] = [];
        let first: TrackedEditApplyOutcome | null = null;
        let last: TrackedEditApplyOutcome | null = null;
        let warning: string | undefined;
        let pass = 0;
        for (;;) {
          const report = await applyTrackedEdits([
            {
              ...edit,
              ...(persistent
                ? { stableEditId: replaceAll ? `${key}#${pass}` : key }
                : {}),
            },
          ]);
          const result = report.edits[0];
          if (!result) {
            throw new Error("Word did not return an edit result.");
          }
          warning = report.warning ?? warning;
          if (result.handle) handles.push(result.handle);
          first ??= result;
          last = result;
          if (abandoned()) {
            if (handles.length > 0) await releaseTrackedEdits(handles);
            return;
          }
          pass += 1;
          if (
            !replaceAll ||
            result.status !== "applied" ||
            (result.remainingTargets ?? 0) === 0 ||
            pass >= MAX_REPLACE_ALL_PASSES
          ) {
            break;
          }
        }
        if (!first || !last) {
          throw new Error("Word did not return an edit result.");
        }

        const appliedCount = handles.length;
        const matchesFound = first.matches;
        // A replace-all card cannot summarize several paragraphs in one
        // snippet; only a uniquely-located edit keeps its hint.
        const locationHint =
          matchesFound === 1 ? first.locationHint : undefined;
        const remainingAfterLast =
          last.status === "applied" ? (last.remainingTargets ?? 0) : 0;
        const partialError =
          replaceAll &&
          appliedCount > 0 &&
          (last.status !== "applied" || remainingAfterLast > 0)
            ? `Applied ${appliedCount} of ${matchesFound} occurrences; the rest couldn’t be applied.`
            : undefined;

        if (appliedCount > 0) {
          editHandlesRef.current.set(key, handles);
          if (first.persistentAnchor) {
            persistentViewEditKeysRef.current.set(
              key,
              persistent && replaceAll ? `${key}#0` : key,
            );
          }
          setEditRuntimeState(key, {
            status: "pending",
            matches: matchesFound,
            appliedMatches: appliedCount,
            locationHint,
            busy: false,
            error: partialError ?? first.error ?? warning,
          });
          void updatePersistedEdit(key, {
            apply_status: "applied",
            matched_occurrences: matchesFound,
            applied_occurrences: appliedCount,
            error_code: partialError ? "partial-application" : null,
            error_message: partialError ?? first.error ?? warning ?? null,
          });
          return;
        }

        if (first.status === "applied-unmanaged") {
          setEditRuntimeState(key, {
            status: "unmanaged",
            matches: matchesFound,
            locationHint,
            busy: false,
            error: first.error ?? warning,
          });
          void updatePersistedEdit(key, {
            apply_status: "unmanaged",
            matched_occurrences: matchesFound,
            applied_occurrences: 0,
            error_code: first.reason ?? "unmanaged",
            error_message: first.error ?? warning ?? null,
          });
          return;
        }
        if (first.reason === "pre-existing-revisions") {
          conflictedRetryRef.current.set(key, {
            edit,
            persistent,
          });
        }
        setEditRuntimeState(key, {
          status:
            first.status === "error"
              ? "error"
              : first.reason === "ambiguous"
                ? "ambiguous"
                : first.reason === "unsearchable"
                  ? "unsearchable"
                  : first.reason === "pre-existing-revisions"
                    ? "conflicted"
                    : "skipped",
          matches: matchesFound,
          busy: false,
          error: first.error,
        });
        void updatePersistedEdit(key, {
          apply_status: "failed",
          matched_occurrences: matchesFound,
          applied_occurrences: 0,
          error_code: first.reason ?? first.status,
          error_message: first.error ?? null,
        });
      })().catch((error: unknown) => {
        if (
          generation !== sessionGenerationRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        setEditRuntimeState(key, {
          status: "error",
          busy: false,
          error:
            error instanceof Error
              ? error.message
              : "Word couldn't apply this change.",
        });
        void updatePersistedEdit(key, {
          apply_status: "failed",
          error_code: "word-error",
          error_message:
            error instanceof Error
              ? error.message
              : "Word couldn't apply this change.",
        });
      });
      editApplyJobsRef.current.set(key, job);
      void job.finally(() => {
        if (editApplyJobsRef.current.get(key) === job) {
          editApplyJobsRef.current.delete(key);
        }
      });
    },
    [
      applyTrackedEdits,
      ensurePersistedEdit,
      setEditRuntimeState,
      updatePersistedEdit,
    ],
  );

  const scheduleDirectEdit = useCallback(
    (
      messageId: string,
      editIndex: number,
      edit: RedlineEdit,
      persistent: boolean,
    ): void => {
      const key = getEditKey(messageId, editIndex);
      if (scheduledEditKeysRef.current.has(key)) return;
      scheduledEditKeysRef.current.add(key);
      beginApplyingEdit(key, edit, persistent, false, "direct");
    },
    [beginApplyingEdit],
  );

  const scheduleReviewEdit = useCallback(
    (
      messageId: string,
      editIndex: number,
      edit: RedlineEdit,
      persistent: boolean,
    ): void => {
      const key = getEditKey(messageId, editIndex);
      if (scheduledEditKeysRef.current.has(key)) return;
      scheduledEditKeysRef.current.add(key);
      setEditRuntimeState(key, { status: "validating", busy: true });
      const generation = sessionGenerationRef.current;
      const job = ensurePersistedEdit(key, edit, "approval")
        .then(() => validateTrackedEdit(edit))
        .then((result) => {
          if (
            generation !== sessionGenerationRef.current ||
            !mountedRef.current
          ) {
            return;
          }
          if (result.status === "ready") {
            readyEditsRef.current.set(key, { edit, persistent });
            setEditRuntimeState(key, {
              status: "ready",
              matches: result.matches,
              busy: false,
              error: undefined,
              viewError: undefined,
            });
            return;
          }
          if (result.reason === "pre-existing-revisions") {
            conflictedRetryRef.current.set(key, { edit, persistent });
          }
          setEditRuntimeState(key, {
            ...editFailureState(result),
            matches: result.matches,
            busy: false,
          });
          void updatePersistedEdit(key, {
            apply_status: "failed",
            matched_occurrences: result.matches,
            applied_occurrences: 0,
            error_code: result.reason ?? result.status,
            error_message: result.error ?? null,
          });
        })
        .catch((error: unknown) => {
          if (
            generation !== sessionGenerationRef.current ||
            !mountedRef.current
          ) {
            return;
          }
          setEditRuntimeState(key, {
            status: "error",
            busy: false,
            error:
              error instanceof Error
                ? error.message
                : "Word couldn't check whether this change can be applied.",
          });
          void updatePersistedEdit(key, {
            apply_status: "failed",
            error_code: "validation-error",
            error_message:
              error instanceof Error
                ? error.message
                : "Word couldn't check whether this change can be applied.",
          });
        });
      editApplyJobsRef.current.set(key, job);
      void job.finally(() => {
        if (editApplyJobsRef.current.get(key) === job) {
          editApplyJobsRef.current.delete(key);
        }
      });
    },
    [ensurePersistedEdit, setEditRuntimeState, updatePersistedEdit],
  );

  const applyReadyEdit = useCallback(
    (key: string): void => {
      const ready = readyEditsRef.current.get(key);
      if (
        !ready ||
        editApplyJobsRef.current.has(key) ||
        resolvingEditKeysRef.current.has(key)
      ) {
        return;
      }
      beginApplyingEdit(key, ready.edit, ready.persistent, true);
    },
    [beginApplyingEdit],
  );

  /**
   * One apply_word_edits batch, run through the ordinary card lifecycle.
   *
   * Nothing here is special-cased for tools: Review mode validates and
   * settles each card on "ready", Edit mode applies a tracked change, and
   * both persist through the same PUT/PATCH rows as a streamed edit. The
   * only addition is reading each card's settled status back out so the
   * caller can post the truth to the awaiting model — which is the whole
   * point of the client tool loop.
   */
  const applyToolEdits = useCallback(
    async (
      messageId: string,
      items: WordToolEditItem[],
      persistent: boolean,
    ): Promise<WordToolEditOutcome[]> => {
      const mode = applyModeRef.current;
      const keys = items.map(({ blockIndex }) =>
        getEditKey(messageId, blockIndex),
      );
      items.forEach(({ blockIndex, edit }) => {
        if (mode === "direct") {
          scheduleDirectEdit(messageId, blockIndex, edit, persistent);
        } else {
          scheduleReviewEdit(messageId, blockIndex, edit, persistent);
        }
      });
      // Every scheduler registers its job synchronously, so the batch's jobs
      // are all present by the time this reads them.
      await Promise.all(
        keys.flatMap((key) => {
          const job = editApplyJobsRef.current.get(key);
          return job ? [job] : [];
        }),
      );
      return keys.map((key, index) => {
        const state = editStateRef.current[key];
        switch (state?.status) {
          case "pending":
            return { index, status: "applied", matches: state.matches };
          case "unmanaged":
            return {
              index,
              status: "applied-unmanaged",
              matches: state.matches,
            };
          // Review mode's success: validated, card ready, waiting on a click.
          case "ready":
            return { index, status: "proposed", matches: state.matches };
          case "ambiguous":
            return {
              index,
              status: "ambiguous",
              matches: state.matches,
              ...(state.error ? { error: state.error } : {}),
            };
          case "skipped":
            return {
              index,
              status: "not-found",
              matches: state.matches,
              ...(state.error ? { error: state.error } : {}),
            };
          case "unsearchable":
            return {
              index,
              status: "skipped",
              reason: "unsearchable",
              ...(state.error ? { error: state.error } : {}),
            };
          case "conflicted":
            return {
              index,
              status: "skipped",
              reason: "pre-existing-revisions",
              ...(state.error ? { error: state.error } : {}),
            };
          case "error":
            return {
              index,
              status: "error",
              ...(state.error ? { error: state.error } : {}),
            };
          default:
            // No settled state means this send no longer owns the session, or
            // the key was already scheduled. Either way the model must not be
            // told the change happened.
            return {
              index,
              status: "error",
              error: "Word did not report a result for this change.",
            };
        }
      });
    },
    [scheduleDirectEdit, scheduleReviewEdit],
  );

  const waitForMessageEdits = useCallback(
    async (messageId: string): Promise<void> => {
      const prefix = `${messageId}:edit-`;
      const jobs = [...editApplyJobsRef.current.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, job]) => job);
      if (jobs.length > 0) await Promise.all(jobs);
    },
    [],
  );

  const processLiveRedlines = useCallback(
    (messageId: string, content: string, persistent: boolean): void => {
      const projection = projectRedlineStream(content);
      let changed = false;
      const next = { ...editStateRef.current };
      projection.edits.forEach((edit) => {
        const key = getEditKey(messageId, edit.blockIndex);
        if (!next[key]) {
          next[key] = { status: "receiving" };
          changed = true;
        }
      });
      if (changed) commitEditState(next);

      projection.edits.forEach((edit) => {
        if (!edit.sealed) return;
        const sealedEdit = toRedlineEdit(edit);
        if (!sealedEdit) return;
        if (applyModeRef.current === "direct") {
          scheduleDirectEdit(
            messageId,
            edit.blockIndex,
            sealedEdit,
            persistent,
          );
        } else {
          scheduleReviewEdit(
            messageId,
            edit.blockIndex,
            sealedEdit,
            persistent,
          );
        }
      });
    },
    [commitEditState, scheduleDirectEdit, scheduleReviewEdit],
  );

  const markIncompleteRedlines = useCallback(
    (messageId: string, content: string): void => {
      const projection = projectRedlineStream(content);
      projection.edits.forEach((edit) => {
        const key = getEditKey(messageId, edit.blockIndex);
        if (!edit.sealed && !scheduledEditKeysRef.current.has(key)) {
          setEditRuntimeState(key, {
            status: "incomplete",
            busy: false,
            error: undefined,
          });
        }
      });
    },
    [setEditRuntimeState],
  );

  /**
   * The conflicted card's "Accept & apply": accept the pending revisions
   * occupying the edit's target, then rerun the edit's normal apply
   * lifecycle from scratch. Two explicit steps — never a layered redline —
   * so a card's Accept/Reject always resolves exactly the revisions it
   * created, and the embedded pending changes are resolved only on an
   * explicit user click, never by a streaming model.
   */
  const acceptAndApplyEdit = useCallback(
    async (key: string): Promise<void> => {
      const retry = conflictedRetryRef.current.get(key);
      if (!retry || resolvingEditKeysRef.current.has(key)) return;
      const generation = sessionGenerationRef.current;
      resolvingEditKeysRef.current.add(key);
      setEditRuntimeState(key, {
        status: "conflicted",
        busy: true,
        busyAction: "accept-and-apply",
        error: undefined,
      });
      try {
        const outcome = await acceptPendingRevisionsForEdit(retry.edit);
        if (
          generation !== sessionGenerationRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        if ("error" in outcome) {
          setEditRuntimeState(key, {
            status: "conflicted",
            busy: false,
            busyAction: undefined,
            error: outcome.error,
          });
          return;
        }
        conflictedRetryRef.current.delete(key);
        beginApplyingEdit(key, retry.edit, retry.persistent, true);
      } finally {
        resolvingEditKeysRef.current.delete(key);
      }
    },
    [acceptPendingRevisionsForEdit, beginApplyingEdit, setEditRuntimeState],
  );

  const viewEdit = useCallback(
    async (key: string): Promise<void> => {
      const ready = readyEditsRef.current.get(key);
      const conflicted = conflictedRetryRef.current.get(key);
      const proposal = ready ?? conflicted;
      if (proposal) {
        if (resolvingEditKeysRef.current.has(key)) return;
        resolvingEditKeysRef.current.add(key);
        const generation = sessionGenerationRef.current;
        setEditRuntimeState(key, {
          busy: true,
          busyAction: "view",
          error: undefined,
          viewError: undefined,
        });
        try {
          const result = await revealProposedEdit(proposal.edit);
          if (
            !mountedRef.current ||
            generation !== sessionGenerationRef.current
          ) {
            return;
          }
          if (result.status === "not-found") {
            readyEditsRef.current.delete(key);
            conflictedRetryRef.current.delete(key);
            setEditRuntimeState(key, {
              status: "skipped",
              busy: false,
              busyAction: undefined,
              error:
                "Skipped — the source text could not be found in the document.",
            });
            void updatePersistedEdit(key, {
              apply_status: "failed",
              matched_occurrences: 0,
              applied_occurrences: 0,
              error_code: "not-found",
              error_message:
                "The source text could not be found in the document.",
            });
            return;
          }
          if (result.status === "ambiguous") {
            readyEditsRef.current.delete(key);
            conflictedRetryRef.current.delete(key);
            setEditRuntimeState(key, {
              status: "ambiguous",
              busy: false,
              busyAction: undefined,
              error: undefined,
            });
            return;
          }
          setEditRuntimeState(key, {
            status: conflicted ? "conflicted" : "ready",
            busy: false,
            busyAction: undefined,
            viewError:
              result.status === "revealed"
                ? undefined
                : (result.error ??
                  "Word couldn’t scroll to this proposed change."),
          });
        } finally {
          resolvingEditKeysRef.current.delete(key);
        }
        return;
      }
      const handles = editHandlesRef.current.get(key) ?? [];
      const firstHandle = handles[0];
      const persistentViewId = persistentViewEditKeysRef.current.get(key);
      if (!firstHandle && !persistentViewId) return;
      const generation = sessionGenerationRef.current;
      const result = persistentViewId
        ? await revealPersistedTrackedEdit(persistentViewId)
        : await revealTrackedEdit(firstHandle as TrackedEditHandle);
      if (!mountedRef.current || generation !== sessionGenerationRef.current) {
        return;
      }
      if (result.status === "not-found" || result.status === "resolved") {
        persistentViewEditKeysRef.current.delete(key);
        if (handles.length > 0) {
          editHandlesRef.current.delete(key);
          void releaseTrackedEdits(handles);
        }
        setEditRuntimeState(key, {
          status: "historical",
          busy: false,
          viewError:
            "Word no longer reports a pending revision for this change.",
        });
        return;
      }
      setEditRuntimeState(key, {
        viewError:
          result.status === "revealed"
            ? undefined
            : (result.error ??
              "Word couldn’t scroll to this change. Find it in Word’s Review tab."),
      });
    },
    [setEditRuntimeState, updatePersistedEdit],
  );

  const resolveOneEdit = useCallback(
    async (key: string, decision: EditDecision): Promise<void> => {
      const handles = editHandlesRef.current.get(key) ?? [];
      if (handles.length === 0 || resolvingEditKeysRef.current.has(key)) {
        return;
      }
      const generation = sessionGenerationRef.current;
      resolvingEditKeysRef.current.add(key);
      setEditRuntimeState(key, {
        busy: true,
        busyAction: decision,
        error: undefined,
        viewError: undefined,
      });

      try {
        if (handles.length === 1) {
          const handle = handles[0] as TrackedEditHandle;
          const result = await resolveTrackedEdit(handle, decision);
          if (
            !mountedRef.current ||
            generation !== sessionGenerationRef.current
          ) {
            return;
          }
          if (result.status === "accepted" || result.status === "rejected") {
            editHandlesRef.current.delete(key);
            persistentViewEditKeysRef.current.delete(key);
            await recordTerminalDecision(key, result.status);
          } else if (
            result.status === "already-resolved" &&
            result.resolvedAs
          ) {
            editHandlesRef.current.delete(key);
            persistentViewEditKeysRef.current.delete(key);
            await recordTerminalDecision(
              key,
              result.resolvedAs === "accept" ? "accepted" : "rejected",
            );
          } else {
            if (result.status === "error" && result.handle !== handle) {
              editHandlesRef.current.set(key, [result.handle]);
              setEditRuntimeState(key, {
                status: "pending",
                busy: false,
                error: result.error,
              });
            } else {
              editHandlesRef.current.delete(key);
              setEditRuntimeState(key, {
                status: "error",
                busy: false,
                error:
                  result.error ?? "The tracked change is no longer available.",
              });
            }
          }
          return;
        }

        // Replace-all card: every retained occurrence resolves together as
        // one decision. Anything short of a uniform terminal outcome hands
        // review back to Word rather than pretending a partial decision.
        const results = await resolveTrackedEdits(handles, decision);
        if (
          !mountedRef.current ||
          generation !== sessionGenerationRef.current
        ) {
          return;
        }
        editHandlesRef.current.delete(key);
        persistentViewEditKeysRef.current.delete(key);
        const decisionOf = (
          result: (typeof results)[number],
        ): "accept" | "reject" | null =>
          result.status === "accepted"
            ? "accept"
            : result.status === "rejected"
              ? "reject"
              : result.status === "already-resolved" && result.resolvedAs
                ? result.resolvedAs
                : null;
        const decisions = results.map(decisionOf);
        if (decisions.every((entry) => entry === "accept")) {
          await recordTerminalDecision(key, "accepted");
        } else if (decisions.every((entry) => entry === "reject")) {
          await recordTerminalDecision(key, "rejected");
        } else {
          setEditRuntimeState(key, {
            status: "error",
            busy: false,
            error:
              results.find((result) => result.error)?.error ??
              "Some of this edit’s tracked changes are no longer available. Review them from Word’s Review tab.",
          });
        }
      } catch (error) {
        reportWordFailure(error, { stage: "resolve" });
        if (
          !mountedRef.current ||
          generation !== sessionGenerationRef.current
        ) {
          return;
        }
        setEditRuntimeState(key, {
          status: "error",
          busy: false,
          error:
            error instanceof Error
              ? error.message
              : "Word couldn't update the tracked change.",
        });
      } finally {
        resolvingEditKeysRef.current.delete(key);
      }
    },
    [recordTerminalDecision, setEditRuntimeState],
  );

  const resolveMessageEdits = useCallback(
    async (editKeys: string[], decision: EditDecision): Promise<void> => {
      const generation = sessionGenerationRef.current;
      const entries = editKeys
        .map((key) => ({
          key,
          handles: editHandlesRef.current.get(key) ?? [],
        }))
        .filter(
          (entry) =>
            entry.handles.length > 0 &&
            !resolvingEditKeysRef.current.has(entry.key),
        );
      if (entries.length === 0) return;

      for (const entry of entries) {
        resolvingEditKeysRef.current.add(entry.key);
        setEditRuntimeState(entry.key, {
          busy: true,
          busyAction: decision,
          error: undefined,
          viewError: undefined,
        });
      }

      try {
        // One flat resolution pass; results group back per card so a
        // replace-all card's occurrences share one verdict.
        const flat = entries.flatMap((entry) =>
          entry.handles.map((handle) => ({ key: entry.key, handle })),
        );
        const results = await resolveTrackedEdits(
          flat.map((item) => item.handle),
          decision,
        );
        if (
          !mountedRef.current ||
          generation !== sessionGenerationRef.current
        ) {
          return;
        }
        const decisionOf = (
          result: (typeof results)[number],
        ): "accept" | "reject" | null =>
          result.status === "accepted"
            ? "accept"
            : result.status === "rejected"
              ? "reject"
              : result.status === "already-resolved" && result.resolvedAs
                ? result.resolvedAs
                : null;
        for (const entry of entries) {
          const cardResults = results.filter(
            (_result, index) => flat[index]?.key === entry.key,
          );
          editHandlesRef.current.delete(entry.key);
          const decisions = cardResults.map(decisionOf);
          if (decisions.every((item) => item === "accept")) {
            persistentViewEditKeysRef.current.delete(entry.key);
            await recordTerminalDecision(entry.key, "accepted");
          } else if (decisions.every((item) => item === "reject")) {
            persistentViewEditKeysRef.current.delete(entry.key);
            await recordTerminalDecision(entry.key, "rejected");
          } else {
            setEditRuntimeState(entry.key, {
              status: "error",
              busy: false,
              error:
                cardResults.find((result) => result.error)?.error ??
                "The tracked change is no longer available.",
            });
          }
        }
      } catch (error) {
        reportWordFailure(error, { stage: "resolve-batch" });
        if (
          !mountedRef.current ||
          generation !== sessionGenerationRef.current
        ) {
          return;
        }
        for (const entry of entries) {
          setEditRuntimeState(entry.key, {
            status: "error",
            busy: false,
            error:
              error instanceof Error
                ? error.message
                : "Word couldn't update the tracked changes.",
          });
        }
      } finally {
        for (const entry of entries) {
          resolvingEditKeysRef.current.delete(entry.key);
        }
      }
    },
    [recordTerminalDecision, setEditRuntimeState],
  );

  // handleChat lists the stream controller among its deps. Handing it an
  // object that also carries editStateByKey would recreate handleChat on
  // every receiving→applying→pending transition mid-stream — exactly the
  // churn the chat hook's message refs exist to prevent — so the behavior is
  // memoized apart from the state it drives.
  const streamController = useMemo<WordEditStreamController>(
    () => ({
      processLiveRedlines,
      markIncompleteRedlines,
      applyToolEdits,
      waitForMessageEdits,
    }),
    [
      applyToolEdits,
      markIncompleteRedlines,
      processLiveRedlines,
      waitForMessageEdits,
    ],
  );

  return {
    editStateByKey,
    streamController,
    applyEdit: applyReadyEdit,
    viewEdit,
    resolveOneEdit,
    resolveMessageEdits,
    acceptAndApplyEdit,
  };
}
