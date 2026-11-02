/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-page Office.js / Word JS API shim.
 *
 * In addition to the ordinary task-pane APIs, this fake keeps the parts of the
 * Word document that genuinely survive a task-pane reload (revisions,
 * bookmarks, and per-document add-in settings) in sessionStorage. JavaScript
 * proxy objects and call logs are intentionally rebuilt on every load. This
 * lets persistence tests exercise the same boundary as Word: the document is
 * still open, but every in-memory Office.js handle has gone away.
 */

export interface OfficeSeed {
  token?: string | null;
  refreshToken?: string | null;
  documentText?: string;
  /**
   * URL exposed as Office.context.document.url. Defaults to a stable fake
   * path; pass a different value to simulate opening a "Save As" copy of the
   * same document, or "" to simulate a never-saved document.
   */
  documentUrl?: string;
  existingTrackedChangeOriginals?: string[];
  unmanagedTrackedChangeOriginals?: string[];
  staleInsertedRangeOriginals?: string[];
  unselectableOriginals?: string[];
  /**
   * Reject the next sync that carries a tracked edit. "before-apply" rolls
   * the mock document back first; "after-apply" keeps the revisions while
   * simulating a lost/failed response from Word.
   */
  trackedMutationSyncFailure?: "before-apply" | "after-apply";
  /** Let this many tracked-edit syncs succeed before that failure fires. */
  trackedMutationSyncFailureAfter?: number;
  /**
   * Structured description of the document body for the markdown document
   * context: when present, body.paragraphs/body.tables exist and describe
   * these blocks; when absent (every pre-existing spec), those collections
   * are undefined and the pane's structured read falls back to body.text —
   * the same shape as a host without the structure APIs.
   */
  documentBlocks?: SeedDocumentBlock[];
}

export interface SeedDocumentBlock {
  text?: string;
  /** Built-in style name, e.g. "Heading1" or "Title". */
  styleBuiltIn?: string;
  /** Present marks the paragraph as a list item with this label. */
  listString?: string;
  listLevel?: number;
  /** Renders this block as a table of these cell values instead. */
  tableValues?: string[][];
}

interface WordCall {
  text: string;
  location: string;
  original?: string;
}

export interface WordCalls {
  inserts: WordCall[];
  trackedChanges: WordCall[];
  changeTrackingMode: string;
  searches: number;
  acceptedChanges: WordCall[];
  rejectedChanges: WordCall[];
  revealedChanges: WordCall[];
  insertedBookmarks: string[];
  deletedBookmarks: string[];
  bookmarkLookups: string[];
}

export interface WordBookmarkSnapshot {
  name: string;
  original?: string;
  text: string;
  revisionCount: number;
  pendingRevisionCount: number;
}

export interface WordDocumentSnapshot {
  bookmarks: WordBookmarkSnapshot[];
  settings: Record<string, unknown>;
}

interface StoredRevision {
  id: string;
  groupId: string;
  type: "Added" | "Deleted" | "Formatted";
  text: string;
  resolution: "accepted" | "rejected" | null;
}

interface StoredRevisionGroup {
  id: string;
  entry: WordCall;
  revisionIds: string[];
  resolution: "accepted" | "rejected" | null;
  /** Set on whole-paragraph deletions: accepting removes this seed block. */
  paragraphIndex?: number;
}

interface StoredBookmark {
  name: string;
  revisionIds: string[];
  entry: WordCall;
}

interface StoredDocumentState {
  revisionSequence: number;
  groupSequence: number;
  revisions: Record<string, StoredRevision>;
  groups: Record<string, StoredRevisionGroup>;
  bookmarks: Record<string, StoredBookmark>;
  settings: Record<string, unknown>;
  /**
   * Seed indexes of documentBlocks removed by accepted whole-paragraph
   * deletions. Like revisions, this is document state that survives a
   * task-pane reload.
   */
  deletedParagraphIndexes?: number[];
  /**
   * Revision-group ids written at each search position, keyed
   * `${query}#${matchIndex}`. Real Word ties revisions to positions in the
   * document; without this, a re-search after an apply would mint fresh
   * ranges that have "forgotten" the revisions sitting at their position —
   * and a replace-all's later passes could never see which occurrences its
   * earlier passes already covered.
   */
  searchAnchors?: Record<string, string[]>;
}

/**
 * Installed through `page.addInitScript`. Keep this function self-contained:
 * Playwright serializes it into the page, so it cannot close over module data.
 */
export function installOfficeMock(seed: OfficeSeed): void {
  const w = window as any;
  const documentStateKey = "__mike_word_e2e_document_v1";
  const officeStorageKey = "__mike_word_e2e_office_storage_v1";
  const accessTokenKey = "mike_token";
  const refreshTokenKey = "mike_refresh_token";
  const editApplyModeKey = "mike_word_edit_apply_mode";
  const chatStorageModePrefix = "mike_word_chat_storage_mode:";

  const clone = <T>(value: T): T => {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value)) as T;
  };
  const emptyDocumentState = (): StoredDocumentState => ({
    revisionSequence: 0,
    groupSequence: 0,
    revisions: {},
    groups: {},
    bookmarks: {},
    settings: {},
    deletedParagraphIndexes: [],
    searchAnchors: {},
  });

  let documentState: StoredDocumentState;
  try {
    const saved = sessionStorage.getItem(documentStateKey);
    documentState = saved
      ? (JSON.parse(saved) as StoredDocumentState)
      : emptyDocumentState();
  } catch {
    documentState = emptyDocumentState();
  }

  const persistDocumentState = (): void => {
    sessionStorage.setItem(documentStateKey, JSON.stringify(documentState));
  };
  if (!sessionStorage.getItem(documentStateKey)) persistDocumentState();
  let trackedMutationSyncFailure = seed.trackedMutationSyncFailure;
  let trackedMutationSyncsBeforeFailure =
    seed.trackedMutationSyncFailureAfter ?? 0;

  const markParagraphDeleted = (paragraphIndex: number): void => {
    const deleted = documentState.deletedParagraphIndexes ?? [];
    if (!deleted.includes(paragraphIndex)) deleted.push(paragraphIndex);
    documentState.deletedParagraphIndexes = deleted;
  };

  /**
   * The seeded blocks minus accepted whole-paragraph deletions, with numeric
   * list labels recomputed over the survivors — the way Word renumbers a
   * list once a member paragraph is gone. Bullet and alpha labels pass
   * through unchanged. Each entry keeps its seed index so a deletion can be
   * tagged back to the block it removes.
   */
  const liveBlocks = (): { block: SeedDocumentBlock; index: number }[] => {
    if (!seed.documentBlocks) return [];
    const deleted = new Set(documentState.deletedParagraphIndexes ?? []);
    const survivors = seed.documentBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ index }) => !deleted.has(index));
    const countersByLevel = new Map<number, number>();
    return survivors.map(({ block, index }) => {
      if (block.tableValues || block.listString === undefined) {
        // A non-list block ends the list; Word starts the next one at 1.
        countersByLevel.clear();
        return { block, index };
      }
      const numeric = /^(\d+)([.)])$/.exec(block.listString);
      if (!numeric) return { block, index };
      const level = block.listLevel ?? 0;
      const next = (countersByLevel.get(level) ?? 0) + 1;
      countersByLevel.set(level, next);
      for (const deeper of Array.from(countersByLevel.keys())) {
        if (deeper > level) countersByLevel.delete(deeper);
      }
      return { block: { ...block, listString: `${next}${numeric[2]}` }, index };
    });
  };

  w.__OFFICE_SEED__ = {
    documentText: seed.documentText ?? "",
  };

  const wordCalls: WordCalls = {
    inserts: [],
    trackedChanges: [],
    changeTrackingMode: "Off",
    searches: 0,
    acceptedChanges: [],
    rejectedChanges: [],
    revealedChanges: [],
    insertedBookmarks: [],
    deletedBookmarks: [],
    bookmarkLookups: [],
  };
  w.__WORD_CALLS__ = wordCalls;

  // ---- OfficeRuntime.storage ----
  const storedOfficeValues: Record<string, string> = {};
  const savedOfficeValues = sessionStorage.getItem(officeStorageKey);
  if (savedOfficeValues !== null) {
    try {
      const parsedOfficeValues = JSON.parse(savedOfficeValues) as Record<
        string,
        string
      >;
      const savedApplyMode = parsedOfficeValues[editApplyModeKey];
      if (savedApplyMode === "approval" || savedApplyMode === "direct") {
        storedOfficeValues[editApplyModeKey] =
          savedApplyMode === "direct" ? "direct" : "approval";
      }
      for (const [key, savedValue] of Object.entries(parsedOfficeValues)) {
        if (
          key.startsWith(chatStorageModePrefix) &&
          (savedValue === "cloud" || savedValue === "local")
        ) {
          storedOfficeValues[key] = savedValue === "local" ? "local" : "cloud";
        }
      }
    } catch {
      // Ignore malformed persisted mock preferences.
    }
  }

  // OfficeRuntime storage is persisted across task-pane reloads by this mock,
  // but auth credentials must never be copied into browser storage. Seeded and
  // newly issued tokens stay in memory for the lifetime of the current page.
  let accessTokenValue = seed.token ?? null;
  let refreshTokenValue = seed.refreshToken ?? null;

  const persistOfficeValues = (): void => {
    sessionStorage.setItem(
      officeStorageKey,
      JSON.stringify(storedOfficeValues),
    );
  };
  w.OfficeRuntime = {
    storage: {
      getItem: (key: string) => {
        if (key === accessTokenKey) return Promise.resolve(accessTokenValue);
        if (key === refreshTokenKey) return Promise.resolve(refreshTokenValue);
        return Promise.resolve(storedOfficeValues[key] ?? null);
      },
      setItem: (key: string, value: string) => {
        if (key === accessTokenKey) {
          accessTokenValue = value;
          return Promise.resolve();
        }
        if (key === refreshTokenKey) {
          refreshTokenValue = value;
          return Promise.resolve();
        }
        if (
          key === editApplyModeKey &&
          (value === "approval" || value === "direct")
        ) {
          storedOfficeValues[key] = value === "direct" ? "direct" : "approval";
          persistOfficeValues();
        } else if (
          key.startsWith(chatStorageModePrefix) &&
          (value === "cloud" || value === "local")
        ) {
          storedOfficeValues[key] = value === "local" ? "local" : "cloud";
          persistOfficeValues();
        }
        return Promise.resolve();
      },
      removeItem: (key: string) => {
        if (key === accessTokenKey) {
          accessTokenValue = null;
          return Promise.resolve();
        }
        if (key === refreshTokenKey) {
          refreshTokenValue = null;
          return Promise.resolve();
        }
        delete storedOfficeValues[key];
        persistOfficeValues();
        return Promise.resolve();
      },
    },
  };

  const AsyncResultStatus = { Succeeded: "succeeded", Failed: "failed" };

  // Office.Settings has an in-memory working copy. saveAsync is the boundary
  // that writes it into the mock Word document.
  let settingsWorkingCopy = clone(documentState.settings);
  const settings = {
    get: (key: string) => clone(settingsWorkingCopy[key]),
    set: (key: string, value: unknown) => {
      settingsWorkingCopy[key] = clone(value);
    },
    remove: (key: string) => {
      delete settingsWorkingCopy[key];
    },
    saveAsync: (callback?: (result: any) => void) => {
      documentState.settings = clone(settingsWorkingCopy);
      persistDocumentState();
      callback?.({ status: AsyncResultStatus.Succeeded, value: undefined });
    },
    refreshAsync: (callback?: (result: any) => void) => {
      settingsWorkingCopy = clone(documentState.settings);
      callback?.({ status: AsyncResultStatus.Succeeded, value: undefined });
    },
  };

  const officeDocument = {
    url: seed.documentUrl ?? "C:/Users/e2e/Demo Contract.docx",
    settings,
  };

  const dialogHandlers = new Map<string, (event: any) => void>();
  const oauthDialog = {
    url: "",
    options: null as Record<string, unknown> | null,
    closed: false,
    sendMessage(message: string, origin = window.location.origin): void {
      dialogHandlers.get("DialogMessageReceived")?.({ message, origin });
    },
    sendEvent(error: number): void {
      dialogHandlers.get("DialogEventReceived")?.({ error });
    },
  };
  w.__OAUTH_DIALOG__ = oauthDialog;

  const dialog = {
    addEventHandler: (eventType: string, handler: (event: any) => void) => {
      dialogHandlers.set(eventType, handler);
    },
    close: () => {
      oauthDialog.closed = true;
    },
  };

  const officeUi = {
    displayDialogAsync: (
      url: string,
      options: Record<string, unknown>,
      callback: (result: any) => void,
    ) => {
      oauthDialog.url = url;
      oauthDialog.options = clone(options);
      oauthDialog.closed = false;
      dialogHandlers.clear();
      callback({
        status: AsyncResultStatus.Succeeded,
        value: dialog,
      });
    },
  };

  const EventType = {
    DialogMessageReceived: "DialogMessageReceived",
    DialogEventReceived: "DialogEventReceived",
  };

  w.Office = {
    onReady: (callback?: any) => {
      const info = { host: "Word", platform: "PC" };
      callback?.(info);
      return Promise.resolve(info);
    },
    context: {
      document: officeDocument,
      ui: officeUi,
      // WordApi (incl. 1.3's Range.compareLocationWith) is mocked below; the
      // WordApiDesktop sets stay unsupported so the app keeps exercising the
      // getTrackedChanges code paths, like Word on the web.
      requirements: {
        isSetSupported: (set: string, _version?: string) => set === "WordApi",
      },
    },
    AsyncResultStatus,
    EventType,
  };

  const InsertLocation = {
    replace: "Replace",
    before: "Before",
    after: "After",
    start: "Start",
    end: "End",
  };
  const ChangeTrackingMode = {
    trackAll: "TrackAll",
    trackMineOnly: "TrackMineOnly",
    off: "Off",
  };

  const snapshotDocument = (): WordDocumentSnapshot => ({
    bookmarks: Object.values(documentState.bookmarks).map((bookmark) => {
      const revisions = bookmark.revisionIds
        .map((id) => documentState.revisions[id])
        .filter((revision): revision is StoredRevision => !!revision);
      return {
        name: bookmark.name,
        original: bookmark.entry.original,
        text: bookmark.entry.text,
        revisionCount: revisions.length,
        pendingRevisionCount: revisions.filter(
          (revision) => revision.resolution === null,
        ).length,
      };
    }),
    settings: clone(documentState.settings),
  });

  w.__WORD_TEST__ = {
    snapshotDocument,
    setSetting: (key: string, value: unknown) => {
      settingsWorkingCopy[key] = clone(value);
      documentState.settings[key] = clone(value);
      persistDocumentState();
    },
    removeSetting: (key: string) => {
      delete settingsWorkingCopy[key];
      delete documentState.settings[key];
      persistDocumentState();
    },
    resolveBookmarkExternally: (
      bookmarkName: string,
      decision: "accepted" | "rejected",
    ) => {
      const bookmark = documentState.bookmarks[bookmarkName];
      if (!bookmark) return false;
      for (const revisionId of bookmark.revisionIds) {
        const revision = documentState.revisions[revisionId];
        if (revision) revision.resolution = decision;
      }
      const groupIds = new Set(
        bookmark.revisionIds
          .map((revisionId) => documentState.revisions[revisionId]?.groupId)
          .filter(Boolean),
      );
      for (const groupId of groupIds) {
        const group = documentState.groups[groupId as string];
        if (group) {
          group.resolution = decision;
          if (decision === "accepted" && group.paragraphIndex !== undefined) {
            markParagraphDeleted(group.paragraphIndex);
          }
        }
      }
      persistDocumentState();
      return true;
    },
    injectRevisionIntoBookmark: (
      bookmarkName: string,
      type: "Added" | "Deleted",
      text: string,
    ) => {
      const bookmark = documentState.bookmarks[bookmarkName];
      if (!bookmark) return false;
      documentState.groupSequence++;
      documentState.revisionSequence++;
      const groupId = `revision-group-${documentState.groupSequence}`;
      const revisionId = `tracked-change-${documentState.revisionSequence}`;
      documentState.revisions[revisionId] = {
        id: revisionId,
        groupId,
        type,
        text,
        resolution: null,
      };
      documentState.groups[groupId] = {
        id: groupId,
        entry: { ...bookmark.entry },
        revisionIds: [revisionId],
        resolution: null,
      };
      bookmark.revisionIds.push(revisionId);
      persistDocumentState();
      return true;
    },
  };

  function makeContext(): any {
    let mutationSyncPending = false;
    let documentStateBeforeMutation: StoredDocumentState | null = null;
    let trackedCallsBeforeMutation = 0;
    const context: any = {
      document: null,
      sync: async () => {
        if (!mutationSyncPending || !trackedMutationSyncFailure) return;
        if (trackedMutationSyncsBeforeFailure > 0) {
          trackedMutationSyncsBeforeFailure -= 1;
          mutationSyncPending = false;
          return;
        }
        const failureMode = trackedMutationSyncFailure;
        trackedMutationSyncFailure = undefined;
        mutationSyncPending = false;
        if (failureMode === "before-apply" && documentStateBeforeMutation) {
          documentState = clone(documentStateBeforeMutation);
          wordCalls.trackedChanges.length = trackedCallsBeforeMutation;
          persistDocumentState();
        }
        throw new Error("GeneralException: tracked mutation sync failed");
      },
    };
    const doc: any = {
      changeTrackingMode: ChangeTrackingMode.off,
      load: (_properties?: any) => undefined,
    };

    const recordWrite = (
      text: string,
      location: string,
      original?: string,
    ): WordCall => {
      const entry: WordCall = { text, location };
      if (original !== undefined) entry.original = original;
      if (doc.changeTrackingMode === ChangeTrackingMode.trackAll) {
        if (trackedMutationSyncFailure && !mutationSyncPending) {
          documentStateBeforeMutation = clone(documentState);
          trackedCallsBeforeMutation = wordCalls.trackedChanges.length;
          mutationSyncPending = true;
        }
        wordCalls.trackedChanges.push(entry);
      } else {
        wordCalls.inserts.push(entry);
      }
      wordCalls.changeTrackingMode = doc.changeTrackingMode;
      return entry;
    };

    const resolveStoredRevision = (
      revisionId: string,
      decision: "accepted" | "rejected",
    ): void => {
      const revision = documentState.revisions[revisionId];
      if (!revision || revision.resolution) return;
      revision.resolution = decision;
      const group = documentState.groups[revision.groupId];
      if (group && !group.resolution) {
        const siblings = group.revisionIds
          .map((id) => documentState.revisions[id])
          .filter((item): item is StoredRevision => !!item);
        const firstSibling = siblings[0];
        if (firstSibling && siblings.every((item) => item.resolution)) {
          group.resolution = firstSibling.resolution;
          if (group.resolution === "accepted") {
            wordCalls.acceptedChanges.push({ ...group.entry });
            // Accepting a whole-paragraph deletion removes the paragraph
            // from the document; rejecting restores it untouched.
            if (group.paragraphIndex !== undefined) {
              markParagraphDeleted(group.paragraphIndex);
            }
          } else {
            wordCalls.rejectedChanges.push({ ...group.entry });
          }
        }
      }
      persistDocumentState();
    };

    const makeTrackedChangeCollection = (items: any[]): any => {
      const collection: any = {
        context,
        items,
        load: (_properties?: any) => undefined,
        track: () => collection,
        untrack: () => collection,
      };
      return collection;
    };

    const makeRange = (args: {
      label: string;
      entry: () => WordCall;
      revisionIds: () => string[];
      /**
       * Identity for compareLocationWith. Positions are real even when the
       * host under-reports revisions (unmanagedTrackedChangeOriginals), so
       * this defaults to revisionIds but can be supplied independently.
       */
      locationIds?: () => string[];
      transientChanges?: () => any[];
      cannotSelect?: boolean;
      stale?: boolean;
      isNullObject?: boolean;
    }): any => {
      const locationIds = args.locationIds ?? args.revisionIds;
      const range: any = {
        context,
        isNullObject: !!args.isNullObject,
        load: (_properties?: any) => undefined,
        track: () => range,
        untrack: () => range,
        select: () => {
          if (args.cannotSelect || args.stale || args.isNullObject) {
            throw new Error("GeneralException");
          }
          wordCalls.revealedChanges.push({ ...args.entry() });
        },
        getTrackedChanges: () => {
          if (args.stale) throw new Error("GeneralException");
          const persistent = args
            .revisionIds()
            .map((id) => documentState.revisions[id])
            .filter(
              (revision): revision is StoredRevision =>
                !!revision && revision.resolution === null,
            )
            .map((revision) => makeStoredTrackedChange(revision.id));
          return makeTrackedChangeCollection([
            ...persistent,
            ...(args.transientChanges?.() ?? []),
          ]);
        },
        expandTo: (other: any) => {
          const ids = (): string[] =>
            Array.from(
              new Set([
                ...args.revisionIds(),
                ...((other.__revisionIds?.() as string[] | undefined) ?? []),
              ]),
            );
          return makeRange({
            label: "Expanded",
            entry: args.entry,
            revisionIds: ids,
            transientChanges: args.transientChanges,
            cannotSelect: args.cannotSelect,
          });
        },
        // Real Word exposes the containing paragraph, whose collection also
        // reports revisions adjacent to this range. The mock's ranges already
        // see their own stored revisions, so the paragraph maps to the range
        // itself.
        paragraphs: {
          getFirst: () => ({ getRange: (_location?: string) => range }),
        },
        // Read-only relation probe (WordApi 1.3). The mock's notion of
        // position is revision-group identity: ranges minted during one
        // apply share that apply's generated revision ids — visible through
        // getTrackedChanges or not — so a revision's own range is "Inside"
        // an anchor from the same logical edit and "Unrelated" to every
        // other one.
        compareLocationWith: (other: any) => {
          const mine = new Set(locationIds());
          const theirs: string[] = other?.__locationIds?.() ?? [];
          const related = theirs.some((id: string) => mine.has(id));
          return { value: related ? "Inside" : "Unrelated" };
        },
        __locationIds: locationIds,
        insertBookmark: (name: string) => {
          if (args.isNullObject) throw new Error("ItemNotFound");
          const entry = args.entry();
          documentState.bookmarks[name] = {
            name,
            revisionIds: Array.from(new Set(args.revisionIds())),
            entry: { ...entry },
          };
          wordCalls.insertedBookmarks.push(name);
          persistDocumentState();
        },
        __revisionIds: args.revisionIds,
      };
      return range;
    };

    const makeStoredTrackedChange = (revisionId: string): any => {
      const revision = documentState.revisions[revisionId];
      if (!revision) {
        throw new Error(`Missing stored revision ${revisionId}`);
      }
      const group = documentState.groups[revision.groupId];
      if (!group) {
        throw new Error(`Missing stored revision group ${revision.groupId}`);
      }
      const change: any = {
        context,
        id: revision.id,
        type: revision.type,
        text: revision.text,
        load: (_properties?: any) => undefined,
        track: () => change,
        untrack: () => change,
        accept: () => resolveStoredRevision(revisionId, "accepted"),
        reject: () => resolveStoredRevision(revisionId, "rejected"),
        getRange: (_location?: string) =>
          makeRange({
            label: "Revision",
            entry: () => ({ ...group.entry }),
            revisionIds: () => [revisionId],
            cannotSelect: (seed.unselectableOriginals ?? []).includes(
              group.entry.original ?? "",
            ),
          }),
      };
      return change;
    };

    let transientChangeSequence = 0;
    const makeTransientTrackedChange = (
      entry: WordCall,
      type: "Formatted" | "Added" | "Deleted" = "Formatted",
      text: string = entry.text,
    ): any => {
      transientChangeSequence++;
      const change: any = {
        context,
        id: `transient-change-${transientChangeSequence}`,
        type,
        text,
        load: (_properties?: any) => undefined,
        track: () => change,
        untrack: () => change,
        accept: () => undefined,
        reject: () => undefined,
        getRange: () =>
          makeRange({
            label: "Existing",
            entry: () => entry,
            revisionIds: () => [],
            transientChanges: () => [change],
          }),
      };
      return change;
    };

    const createStoredRevisionGroup = (
      entry: WordCall,
      original: string,
      replacement: string,
      paragraphIndex?: number,
    ): string[] => {
      documentState.groupSequence++;
      const groupId = `revision-group-${documentState.groupSequence}`;
      const revisions: StoredRevision[] = [
        { id: "", groupId, type: "Deleted", text: original, resolution: null },
        // A pure deletion produces no Added revision in real Word.
        ...(replacement.length > 0
          ? [
              {
                id: "",
                groupId,
                type: "Added" as const,
                // Real Word exposes inserted paragraph marks as carriage
                // returns.
                text: replacement.replace(/\n/g, "\r"),
                resolution: null,
              },
            ]
          : []),
      ];
      for (const revision of revisions) {
        documentState.revisionSequence++;
        revision.id = `tracked-change-${documentState.revisionSequence}`;
        documentState.revisions[revision.id] = revision;
      }
      documentState.groups[groupId] = {
        id: groupId,
        entry: { ...entry },
        revisionIds: revisions.map((revision) => revision.id),
        resolution: null,
        ...(paragraphIndex !== undefined ? { paragraphIndex } : {}),
      };
      persistDocumentState();
      return revisions.map((revision) => revision.id);
    };

    // Restyling a revision-free range under TrackAll yields one "Formatted"
    // revision covering the passage, mirroring real Word.
    const createFormattedRevisionGroup = (
      entry: WordCall,
      text: string,
    ): string[] => {
      documentState.groupSequence++;
      const groupId = `revision-group-${documentState.groupSequence}`;
      documentState.revisionSequence++;
      const revisionId = `tracked-change-${documentState.revisionSequence}`;
      documentState.revisions[revisionId] = {
        id: revisionId,
        groupId,
        type: "Formatted",
        text,
        resolution: null,
      };
      documentState.groups[groupId] = {
        id: groupId,
        entry: { ...entry },
        revisionIds: [revisionId],
        resolution: null,
      };
      persistDocumentState();
      return [revisionId];
    };

    const body = {
      get text() {
        return w.__OFFICE_SEED__.documentText as string;
      },
      load: (_properties?: any) => undefined,
      // Mirrors real Word: the document-level collection reliably reports
      // every pending revision even when range-scoped reads come up short.
      getTrackedChanges: () =>
        makeTrackedChangeCollection(
          Object.values(documentState.revisions)
            .filter((revision) => revision.resolution === null)
            .map((revision) => makeStoredTrackedChange(revision.id)),
        ),
      search: (query: string, options?: any) => {
        wordCalls.searches++;
        const documentText: string = w.__OFFICE_SEED__.documentText || "";
        const haystack = options?.matchCase
          ? documentText
          : documentText.toLowerCase();
        const needle = options?.matchCase
          ? String(query)
          : String(query).toLowerCase();
        let matchCount = 0;
        let cursor = 0;
        while (needle && cursor <= haystack.length - needle.length) {
          const foundAt = haystack.indexOf(needle, cursor);
          if (foundAt < 0) break;
          matchCount++;
          cursor = foundAt + needle.length;
        }

        // When the seed describes blocks, tie each match to the surviving
        // block containing the query so paragraph-level reads and deletions
        // have a real target. Matches beyond the block list (or with no
        // block seed at all) keep the flat-text behavior.
        const blockMatches = seed.documentBlocks
          ? liveBlocks().filter(
              ({ block }) =>
                !block.tableValues &&
                (block.text ?? "").includes(String(query)),
            )
          : [];

        const items = Array.from({ length: matchCount }, (_, itemIndex) => {
          const matchedBlock = blockMatches[itemIndex] ?? null;
          let generatedRevisionIds: string[] = [];
          // Ties the revisions written through this match to its POSITION,
          // so a later search of the same query sees them again (real Word
          // anchors revisions in the document; a fresh RangeCollection does
          // not forget them).
          const positionKey = `${String(query)}#${itemIndex}`;
          const rememberPositionRevisions = (): void => {
            if (generatedRevisionIds.length === 0) return;
            documentState.searchAnchors = documentState.searchAnchors ?? {};
            documentState.searchAnchors[positionKey] = generatedRevisionIds;
            persistDocumentState();
          };
          const positionRevisionIds = (): string[] =>
            Array.from(
              new Set([
                ...(documentState.searchAnchors?.[positionKey] ?? []),
                ...generatedRevisionIds,
              ]),
            );
          let lastWrite: WordCall | null = null;
          const existingChanges = (
            seed.existingTrackedChangeOriginals ?? []
          ).includes(query)
            ? [
                (() => {
                  const change = makeTransientTrackedChange({
                    text: query,
                    location: "Existing",
                    original: query,
                  });
                  // Accepting a pre-existing revision (the conflicted
                  // card's "Accept & apply") resolves it for real: record
                  // the acceptance and retire the seed so subsequent
                  // searches see the passage revision-free — mirroring
                  // Word, where an accepted change stops being pending.
                  change.accept = () => {
                    wordCalls.acceptedChanges.push({
                      text: query,
                      location: "Existing",
                      original: query,
                    });
                    seed.existingTrackedChangeOriginals = (
                      seed.existingTrackedChangeOriginals ?? []
                    ).filter((original) => original !== query);
                  };
                  return change;
                })(),
              ]
            : [];
          const revisionsVisible = !(
            seed.unmanagedTrackedChangeOriginals ?? []
          ).includes(query);

          const makeSearchRange = (label: "Select" | "Inserted"): any => {
            const stale =
              label === "Inserted" &&
              (seed.staleInsertedRangeOriginals ?? []).includes(query);
            return makeRange({
              label,
              entry: () =>
                lastWrite ?? {
                  text: query,
                  location: label,
                  original: query,
                },
              revisionIds: () =>
                revisionsVisible ? positionRevisionIds() : [],
              // Location identity ignores revisionsVisible: a host that hides
              // revisions from a range still knows where the range IS.
              locationIds: () => positionRevisionIds(),
              transientChanges: () =>
                positionRevisionIds().length > 0 ? [] : existingChanges,
              stale,
              cannotSelect: (seed.unselectableOriginals ?? []).includes(query),
            });
          };

          const range = makeSearchRange("Select");
          range.insertText = (newText: string, location: string) => {
            const entry = recordWrite(newText, location, query);
            lastWrite = entry;
            if (doc.changeTrackingMode === ChangeTrackingMode.trackAll) {
              generatedRevisionIds = createStoredRevisionGroup(
                entry,
                query,
                newText,
              );
              rememberPositionRevisions();
            } else {
              generatedRevisionIds = [];
            }
            return makeSearchRange("Inserted");
          };
          // Tracked deletion of the matched passage. The app authors a
          // replacement as insertText(after) + delete(); when insertText
          // already materialized the revision group (which the mock builds
          // whole, mirroring the host's replace pair), this is a no-op —
          // but a pure deletion (no insert) materializes a Deleted-only
          // group here.
          range.delete = () => {
            if (
              doc.changeTrackingMode === ChangeTrackingMode.trackAll &&
              generatedRevisionIds.length === 0
            ) {
              const entry = recordWrite("", "Delete", query);
              lastWrite = entry;
              generatedRevisionIds = createStoredRevisionGroup(
                entry,
                query,
                "",
              );
              rememberPositionRevisions();
            }
          };
          // Formatting the found passage: each font-property write is
          // recorded, and the first one under TrackAll materializes one
          // Formatted revision (Word coalesces per contiguous run).
          const recordFormatWrite = (property: string): void => {
            const entry = recordWrite(query, `Format:${property}`, query);
            lastWrite = entry;
            if (
              doc.changeTrackingMode === ChangeTrackingMode.trackAll &&
              generatedRevisionIds.length === 0
            ) {
              generatedRevisionIds = createFormattedRevisionGroup(entry, query);
              rememberPositionRevisions();
            }
          };
          range.font = {
            set bold(_value: boolean) {
              recordFormatWrite("bold");
            },
            set italic(_value: boolean) {
              recordFormatWrite("italic");
            },
            set underline(_value: unknown) {
              recordFormatWrite("underline");
            },
          };
          // The containing paragraph. When the match resolved to a seeded
          // block it reports that block's text (with the trailing paragraph
          // mark real Word appends) so the app's whole-paragraph deletion
          // check has something true to compare against; getRange("Whole")
          // then yields a range whose delete() removes the paragraph itself
          // — a Deleted revision carrying the paragraph mark, tagged with
          // the block it deletes on accept. Paragraph styles record like
          // font writes, as before.
          range.paragraphs = {
            getFirst: () => ({
              load: (_p?: any) => undefined,
              get text() {
                return matchedBlock ? `${matchedBlock.block.text ?? ""}\r` : "";
              },
              isListItem: matchedBlock?.block.listString !== undefined,
              tableNestingLevel: 0,
              set styleBuiltIn(value: unknown) {
                recordFormatWrite(`style:${String(value)}`);
              },
              getRange: (location?: string) => {
                const paragraphRange = makeSearchRange("Select");
                if (location === "Whole" && matchedBlock) {
                  paragraphRange.delete = () => {
                    if (
                      doc.changeTrackingMode === ChangeTrackingMode.trackAll &&
                      generatedRevisionIds.length === 0
                    ) {
                      const entry = recordWrite("", "DeleteParagraph", query);
                      lastWrite = entry;
                      generatedRevisionIds = createStoredRevisionGroup(
                        entry,
                        `${matchedBlock.block.text ?? ""}\r`,
                        "",
                        matchedBlock.index,
                      );
                      rememberPositionRevisions();
                    }
                  };
                }
                return paragraphRange;
              },
            }),
          };
          return range;
        });
        return { items, load: (_properties?: any) => undefined };
      },
    };

    // Structure APIs exist only when the seed describes blocks; otherwise
    // the pane's structured read throws on the missing collections and
    // falls back to flat body.text, like a host without these APIs.
    if (seed.documentBlocks) {
      // Getters, not eager arrays: a whole-paragraph deletion accepted in
      // one Word.run must be gone (and the list renumbered) when the next
      // structured read walks the body.
      (body as any).paragraphs = {
        load: (_properties?: any) => undefined,
        get items() {
          return liveBlocks().flatMap(({ block }) => {
            if (block.tableValues) {
              // One stand-in cell paragraph per table: the pane's body walker
              // only needs the 0→N tableNestingLevel transition to splice the
              // table (from body.tables) in at this position.
              return [
                {
                  text: "",
                  styleBuiltIn: "Normal",
                  isListItem: false,
                  tableNestingLevel: 1,
                  listItemOrNullObject: {
                    isNullObject: true,
                    load: (_p?: any) => undefined,
                  },
                },
              ];
            }
            return [
              {
                text: block.text ?? "",
                styleBuiltIn: block.styleBuiltIn ?? "Normal",
                isListItem: block.listString !== undefined,
                tableNestingLevel: 0,
                listItemOrNullObject: {
                  isNullObject: block.listString === undefined,
                  listString: block.listString,
                  level: block.listLevel ?? 0,
                  load: (_p?: any) => undefined,
                },
              },
            ];
          });
        },
      };
      (body as any).tables = {
        load: (_properties?: any) => undefined,
        get items() {
          return liveBlocks()
            .filter(({ block }) => block.tableValues)
            .map(({ block }) => ({
              nestingLevel: 1,
              values: block.tableValues,
              load: (_p?: any) => undefined,
            }));
        },
      };
    }

    doc.body = body;
    doc.getBookmarkRangeOrNullObject = (name: string) => {
      wordCalls.bookmarkLookups.push(name);
      const bookmark = documentState.bookmarks[name];
      if (!bookmark) {
        return makeRange({
          label: "Bookmark",
          entry: () => ({ text: "", location: "Bookmark" }),
          revisionIds: () => [],
          isNullObject: true,
        });
      }
      return makeRange({
        label: "Bookmark",
        entry: () => ({ ...bookmark.entry }),
        revisionIds: () => [...bookmark.revisionIds],
      });
    };
    doc.deleteBookmark = (name: string) => {
      if (documentState.bookmarks[name]) {
        delete documentState.bookmarks[name];
        wordCalls.deletedBookmarks.push(name);
        persistDocumentState();
      }
    };
    context.document = doc;
    return context;
  }

  w.Word = {
    UnderlineType: { single: "Single" },
    BuiltInStyleName: {
      heading1: "Heading1",
      heading2: "Heading2",
      heading3: "Heading3",
    },
    run: (objectOrCallback: any, maybeCallback?: any) => {
      const callback = maybeCallback ?? objectOrCallback;
      const target = Array.isArray(objectOrCallback)
        ? objectOrCallback[0]
        : objectOrCallback;
      const context = maybeCallback ? target?.context : makeContext();
      return Promise.resolve().then(() => callback(context));
    },
    InsertLocation,
    ChangeTrackingMode,
  };
}
