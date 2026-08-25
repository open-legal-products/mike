"use client";

import {
    createContext,
    type Dispatch,
    type ReactNode,
    type SetStateAction,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, FolderUp, Plus, Upload } from "lucide-react";
import { DocTable } from "@/app/components/documents/DocTable";
import type {
  DocTableFolderBreadcrumb,
  DocTableFolder,
  DocTableQuery,
} from "@/app/components/documents/DocTable";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import {
  bulkDeleteLibraryDocuments,
    createLibraryFolder,
    deleteLibraryFolder,
    getLibrary,
    getLibraryFilterOptions,
    getLibraryFolderChildren,
    getLibraryFolderPath,
  getLibraryLevels,
  listLibraryDocumentIds,
    moveLibraryDocument,
    moveLibraryFolder,
    renameLibraryDocument,
    renameLibraryFolder,
  resolveLibraryFolderPath,
  searchLibraryDocuments,
    uploadLibraryDocument,
    uploadLibraryDocuments,
    type LibraryKind,
} from "@/app/lib/mikeApi";
import type { Document } from "@/app/components/shared/types";
import { useDebouncedValue } from "@/app/hooks/useDebouncedValue";

type LibraryViewCollection = {
    documents: Document[];
    folders: DocTableFolder[];
};

type LibraryWorkspaceContextValue = {
    collections: Record<LibraryKind, LibraryViewCollection | null>;
    loadingByKind: Record<LibraryKind, boolean>;
    searchByKind: Record<LibraryKind, string>;
    loadedFolderIdsByKind: Record<LibraryKind, Set<string>>;
    documentsHasMoreByKind: Record<LibraryKind, Record<string, boolean>>;
    loadingMoreDocumentsByKind: Record<LibraryKind, Record<string, boolean>>;
    loadLibrary: (
        kind: LibraryKind,
        options?: { showLoading?: boolean },
    ) => Promise<void>;
    loadFolderChildren: (kind: LibraryKind, folderId: string) => Promise<void>;
    loadMoreDocuments: (
        kind: LibraryKind,
        parentId: string | null,
    ) => Promise<void>;
    setSearchForKind: (kind: LibraryKind, value: string) => void;
    setDocumentsForKind: (
        kind: LibraryKind,
        update: SetStateAction<Document[]>,
    ) => void;
    setFoldersForKind: (
        kind: LibraryKind,
        update: SetStateAction<DocTableFolder[]>,
    ) => void;
};

const LIBRARY_TABS: { id: LibraryKind; label: string }[] = [
    { id: "files", label: "Files" },
    { id: "templates", label: "Templates" },
];

const EMPTY_COLLECTION: LibraryViewCollection = {
    documents: [],
    folders: [],
};

// Sentinel key identifying the root level in the per-level pagination maps
// below (folder levels are keyed by their real folder id, which is always a
// uuid and so can never collide with this).
const ROOT_LEVEL_KEY = "root";
const DOCUMENT_PAGE_SIZE = 40;

function libraryLevelKey(parentId: string | null): string {
    return parentId ?? ROOT_LEVEL_KEY;
}

const LibraryWorkspaceContext =
    createContext<LibraryWorkspaceContextValue | null>(null);

function useLibraryWorkspace() {
    const context = useContext(LibraryWorkspaceContext);
    if (!context) {
        throw new Error(
            "useLibraryWorkspace must be used inside LibraryWorkspaceProvider",
        );
    }
    return context;
}

export function LibraryWorkspaceProvider({
    children,
}: {
    children: ReactNode;
}) {
    const [collections, setCollections] = useState<
        Record<LibraryKind, LibraryViewCollection | null>
    >({
        files: null,
        templates: null,
    });
    const [loadingByKind, setLoadingByKind] = useState<
        Record<LibraryKind, boolean>
    >({
        files: false,
        templates: false,
    });
  const [searchByKind, setSearchByKind] = useState<Record<LibraryKind, string>>(
    {
        files: "",
        templates: "",
    },
  );
    const [loadedFolderIdsByKind, setLoadedFolderIdsByKind] = useState<
        Record<LibraryKind, Set<string>>
    >({
        files: new Set(),
        templates: new Set(),
    });
    // Per-level (root or folder id) document paging state: how many
    // documents are currently requested for that level, whether the server
    // has more beyond that, and whether a "load more" fetch is in flight.
    const [documentLimitByKind, setDocumentLimitByKind] = useState<
        Record<LibraryKind, Record<string, number>>
  >({
    files: {},
    templates: {},
  });
    const [documentsHasMoreByKind, setDocumentsHasMoreByKind] = useState<
        Record<LibraryKind, Record<string, boolean>>
  >({
    files: {},
    templates: {},
  });
  const [loadingMoreDocumentsByKind, setLoadingMoreDocumentsByKind] = useState<
    Record<LibraryKind, Record<string, boolean>>
  >({
            files: {},
            templates: {},
        });
    const folderChildrenRequestsRef = useRef<Map<string, Promise<void>>>(
        new Map(),
    );
    const loadMoreDocumentsRequestsRef = useRef<Map<string, Promise<void>>>(
        new Map(),
    );

    // Refetches root-level content plus every folder level already lazy-loaded
    // for this kind (each level re-requested at its current page size), so a
    // refresh (e.g. after uploading a new document version) doesn't drop the
    // contents of folders the user has expanded, or documents loaded beyond
    // the first page.
    const loadLibrary = useCallback(
        async (kind: LibraryKind, options: { showLoading?: boolean } = {}) => {
            if (options.showLoading) {
                setLoadingByKind((prev) => ({ ...prev, [kind]: true }));
            }
            try {
                const loadedFolderIds = [...loadedFolderIdsByKind[kind]];
                const limits = documentLimitByKind[kind];
        const response = await getLibraryLevels(kind, [
          {
            parentId: null,
                        limit: limits[ROOT_LEVEL_KEY] ?? DOCUMENT_PAGE_SIZE,
          },
          ...loadedFolderIds.map((folderId) => ({
            parentId: folderId,
                                limit: limits[folderId] ?? DOCUMENT_PAGE_SIZE,
          })),
                ]);
        const root = response.levels.find((level) => level.parentId === null);
        if (!root) throw new Error("Library root was not returned");

                const documents = [...root.documents];
                const folders = [...root.folders];
                const seenDocIds = new Set(documents.map((d) => d.id));
                const seenFolderIds = new Set(folders.map((f) => f.id));
                const stillLoaded = new Set<string>();
                const nextHasMore: Record<string, boolean> = {
                    [ROOT_LEVEL_KEY]: root.documentsHasMore,
                };

        response.levels.forEach((level) => {
          const folderId = level.parentId;
          if (!folderId) return;
                    stillLoaded.add(folderId);
          nextHasMore[folderId] = level.documentsHasMore;
          for (const doc of level.documents) {
                        if (seenDocIds.has(doc.id)) continue;
                        seenDocIds.add(doc.id);
                        documents.push(doc);
                    }
          for (const folder of level.folders) {
                        if (seenFolderIds.has(folder.id)) continue;
                        seenFolderIds.add(folder.id);
                        folders.push(folder);
                    }
                });

                setCollections((prev) => ({
                    ...prev,
                    [kind]: { documents, folders },
                }));
                setLoadedFolderIdsByKind((prev) => ({
                    ...prev,
                    [kind]: stillLoaded,
                }));
                setDocumentsHasMoreByKind((prev) => ({
                    ...prev,
                    [kind]: nextHasMore,
                }));
        setDocumentLimitByKind((prev) => ({
          ...prev,
          [kind]: {
            [ROOT_LEVEL_KEY]: root.documents.length,
            ...Object.fromEntries(
              loadedFolderIds.map((folderId) => [
                folderId,
                documents.filter(
                  (document) => (document.folder_id ?? null) === folderId,
                ).length,
              ]),
            ),
          },
        }));
            } catch (error) {
                console.error("[library] failed to load", error);
                setCollections((prev) => ({
                    ...prev,
                    [kind]: EMPTY_COLLECTION,
                }));
                setLoadedFolderIdsByKind((prev) => ({
                    ...prev,
                    [kind]: new Set(),
                }));
                setDocumentLimitByKind((prev) => ({ ...prev, [kind]: {} }));
                setDocumentsHasMoreByKind((prev) => ({ ...prev, [kind]: {} }));
            } finally {
                if (options.showLoading) {
                    setLoadingByKind((prev) => ({ ...prev, [kind]: false }));
                }
            }
        },
        [loadedFolderIdsByKind, documentLimitByKind],
    );

    const loadFolderChildren = useCallback(
        async (kind: LibraryKind, folderId: string) => {
            if (loadedFolderIdsByKind[kind].has(folderId)) return;
            const key = `${kind}:${folderId}`;
            const inFlight = folderChildrenRequestsRef.current.get(key);
            if (inFlight) return inFlight;

            const request = (async () => {
                try {
          const children = await getLibraryFolderChildren(kind, folderId, {
            limit: DOCUMENT_PAGE_SIZE,
          });
                    setCollections((prev) => {
                        const current = prev[kind] ?? EMPTY_COLLECTION;
            const existingDocIds = new Set(current.documents.map((d) => d.id));
            const existingFolderIds = new Set(current.folders.map((f) => f.id));
                        return {
                            ...prev,
                            [kind]: {
                                documents: [
                                    ...current.documents,
                  ...children.documents.filter((d) => !existingDocIds.has(d.id)),
                                ],
                                folders: [
                                    ...current.folders,
                                    ...children.folders.filter(
                                        (f) => !existingFolderIds.has(f.id),
                                    ),
                                ],
                            },
                        };
                    });
                    setLoadedFolderIdsByKind((prev) => {
                        const next = new Set(prev[kind]);
                        next.add(folderId);
                        return { ...prev, [kind]: next };
                    });
                    setDocumentLimitByKind((prev) => ({
                        ...prev,
            [kind]: {
              ...prev[kind],
              [folderId]: DOCUMENT_PAGE_SIZE,
            },
                    }));
                    setDocumentsHasMoreByKind((prev) => ({
                        ...prev,
                        [kind]: {
                            ...prev[kind],
                            [folderId]: children.documentsHasMore,
                        },
                    }));
                } catch (error) {
          console.error("[library] failed to load folder children", error);
                } finally {
                    folderChildrenRequestsRef.current.delete(key);
                }
            })();
            folderChildrenRequestsRef.current.set(key, request);
            return request;
        },
        [loadedFolderIdsByKind],
    );

  // Fetches a fixed-size next page for one level. The old implementation
  // repeatedly fetched 100, then 150, then 200 rows from offset zero, which
  // made scrolling transfer the same rows over and over.
    const loadMoreDocuments = useCallback(
        async (kind: LibraryKind, parentId: string | null) => {
            const levelKey = libraryLevelKey(parentId);
            const requestKey = `${kind}:${levelKey}`;
            const inFlight = loadMoreDocumentsRequestsRef.current.get(requestKey);
            if (inFlight) return inFlight;

      const offset = documentLimitByKind[kind][levelKey] ?? 0;
            setLoadingMoreDocumentsByKind((prev) => ({
                ...prev,
                [kind]: { ...prev[kind], [levelKey]: true },
            }));

            const request = (async () => {
                try {
                    const page =
                        parentId === null
              ? await getLibrary(kind, {
                  limit: DOCUMENT_PAGE_SIZE,
                  offset,
                })
                            : await getLibraryFolderChildren(kind, parentId, {
                  limit: DOCUMENT_PAGE_SIZE,
                  offset,
                              });

                    setCollections((prev) => {
                        const current = prev[kind] ?? EMPTY_COLLECTION;
            const existingDocumentIds = new Set(
              current.documents.map((document) => document.id),
            );
            const existingFolderIds = new Set(
              current.folders.map((folder) => folder.id),
            );
                        const documents = [
              ...current.documents,
              ...page.documents.filter(
                (document) => !existingDocumentIds.has(document.id),
                            ),
                        ];
                        const folders = [
              ...current.folders,
              ...page.folders.filter(
                (folder) => !existingFolderIds.has(folder.id),
                            ),
                        ];
                        return { ...prev, [kind]: { documents, folders } };
                    });
                    setDocumentLimitByKind((prev) => ({
                        ...prev,
            [kind]: {
              ...prev[kind],
              [levelKey]: offset + page.documents.length,
            },
                    }));
                    setDocumentsHasMoreByKind((prev) => ({
                        ...prev,
                        [kind]: {
                            ...prev[kind],
                            [levelKey]: page.documentsHasMore,
                        },
                    }));
                } catch (error) {
          console.error("[library] failed to load more documents", error);
                } finally {
                    setLoadingMoreDocumentsByKind((prev) => ({
                        ...prev,
                        [kind]: { ...prev[kind], [levelKey]: false },
                    }));
                    loadMoreDocumentsRequestsRef.current.delete(requestKey);
                }
            })();
            loadMoreDocumentsRequestsRef.current.set(requestKey, request);
            return request;
        },
        [documentLimitByKind],
    );

    const setSearchForKind = useCallback((kind: LibraryKind, value: string) => {
        setSearchByKind((prev) => ({ ...prev, [kind]: value }));
    }, []);

    const setDocumentsForKind = useCallback(
        (kind: LibraryKind, update: SetStateAction<Document[]>) => {
            setCollections((prev) => {
                const current = prev[kind] ?? EMPTY_COLLECTION;
                const nextDocuments =
          typeof update === "function" ? update(current.documents) : update;
                return {
                    ...prev,
                    [kind]: {
                        ...current,
                        documents: nextDocuments,
                    },
                };
            });
        },
        [],
    );

    const setFoldersForKind = useCallback(
        (kind: LibraryKind, update: SetStateAction<DocTableFolder[]>) => {
            setCollections((prev) => {
                const current = prev[kind] ?? EMPTY_COLLECTION;
                const nextFolders =
          typeof update === "function" ? update(current.folders) : update;
                return {
                    ...prev,
                    [kind]: {
                        ...current,
                        folders: nextFolders,
                    },
                };
            });
        },
        [],
    );

    const value = useMemo(
        () => ({
            collections,
            loadingByKind,
            searchByKind,
            loadedFolderIdsByKind,
            documentsHasMoreByKind,
            loadingMoreDocumentsByKind,
            loadLibrary,
            loadFolderChildren,
            loadMoreDocuments,
            setSearchForKind,
            setDocumentsForKind,
            setFoldersForKind,
        }),
        [
            collections,
            loadingByKind,
            loadedFolderIdsByKind,
            documentsHasMoreByKind,
            loadingMoreDocumentsByKind,
            loadLibrary,
            loadFolderChildren,
            loadMoreDocuments,
            searchByKind,
            setDocumentsForKind,
            setFoldersForKind,
            setSearchForKind,
        ],
    );

    return (
        <LibraryWorkspaceContext.Provider value={value}>
            {children}
        </LibraryWorkspaceContext.Provider>
    );
}

export function LibraryWorkspaceLayout({ children }: { children: ReactNode }) {
    return <LibraryWorkspaceProvider>{children}</LibraryWorkspaceProvider>;
}

export function LibraryCollectionPage({
    kind,
    folderId = null,
}: {
    kind: LibraryKind;
    folderId?: string | null;
}) {
    const router = useRouter();
    const {
        collections,
        loadingByKind,
        searchByKind,
        documentsHasMoreByKind,
        loadingMoreDocumentsByKind,
        loadLibrary,
        loadFolderChildren,
        loadMoreDocuments,
        setSearchForKind,
        setDocumentsForKind,
        setFoldersForKind,
    } = useLibraryWorkspace();
    const collection = collections[kind];
    const collectionLoaded = collection !== null;
    const search = searchByKind[kind];
    const collectionRootPath = kind === "files" ? "/library" : "/library/templates";
  const debouncedSearch = useDebouncedValue(search, 250);
    const title = kind === "files" ? "Files" : "Templates";
  const [documentTypeOptions, setDocumentTypeOptions] = useState<string[]>([]);
  const [tableQuery, setTableQuery] = useState<DocTableQuery>({
    search: "",
    fileType: null,
    sort: null,
  });
  const [serverDocuments, setServerDocuments] = useState<Document[] | null>(
    null,
  );
  const [serverQueryLoading, setServerQueryLoading] = useState(false);
  const [serverQueryLoadingMore, setServerQueryLoadingMore] = useState(false);
  const [serverQueryHasMore, setServerQueryHasMore] = useState(false);
  const [serverQueryRefreshVersion, setServerQueryRefreshVersion] = useState(0);
  const serverQueryRequestRef = useRef(0);
    const loadedFolderRouteRef = useRef<string | null>(null);
    const loadFolderChildrenRef = useRef(loadFolderChildren);
    loadFolderChildrenRef.current = loadFolderChildren;
    const folderAvailable =
        !folderId ||
        !!collection?.folders.some((folder) => folder.id === folderId);
    const folderAvailableRef = useRef(folderAvailable);
    folderAvailableRef.current = folderAvailable;

    useEffect(() => {
        if (collection) return;
        void loadLibrary(kind, { showLoading: true });
    }, [collection, kind, loadLibrary]);

    useEffect(() => {
        if (!folderId) {
            loadedFolderRouteRef.current = null;
            return;
        }
        if (!collectionLoaded) return;

        const routeKey = `${kind}:${folderId}`;
        if (loadedFolderRouteRef.current === routeKey) return;
        loadedFolderRouteRef.current = routeKey;
        let cancelled = false;

        const loadRoute = folderAvailableRef.current
            ? Promise.resolve()
            : getLibraryFolderPath(kind, folderId).then(
                  ({ folders: path }) => {
                      if (cancelled) return;
                      setFoldersForKind(kind, (current) => {
                          const pathById = new Map(
                              path.map((folder) => [folder.id, folder]),
                          );
                          const merged = current.map(
                              (folder) =>
                                  pathById.get(folder.id) ?? folder,
                          );
                          const currentIds = new Set(
                              current.map((folder) => folder.id),
                          );
                          return [
                              ...merged,
                              ...path.filter(
                                  (folder) => !currentIds.has(folder.id),
                              ),
                          ];
                      });
                  },
              );

        void loadRoute
            .then(() => {
                if (cancelled) return;
                return loadFolderChildrenRef.current(kind, folderId);
            })
            .catch((error) => {
                console.error("[library] failed to load folder route", error);
                loadedFolderRouteRef.current = null;
                if (!cancelled) {
                    router.replace(collectionRootPath, { scroll: false });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [
        collectionLoaded,
        collectionRootPath,
        folderId,
        kind,
        router,
        setFoldersForKind,
    ]);

    const handleFolderViewIdChange = useCallback(
        (nextFolderId: string | null) => {
            const nextPath = nextFolderId
                ? `${collectionRootPath}/folders/${encodeURIComponent(nextFolderId)}`
                : collectionRootPath;
            router.push(nextPath, { scroll: false });
        },
        [collectionRootPath, router],
    );

    const setDocuments: Dispatch<SetStateAction<Document[]>> = useCallback(
    (update) => {
      setDocumentsForKind(kind, update);
      setServerDocuments((current) => {
        if (current === null) return null;
        return typeof update === "function" ? update(current) : update;
      });
    },
        [kind, setDocumentsForKind],
    );
    const setFolders: Dispatch<SetStateAction<DocTableFolder[]>> = useCallback(
        (update) => setFoldersForKind(kind, update),
        [kind, setFoldersForKind],
    );
    const [addDocumentsAction, setAddDocumentsAction] = useState<
        (() => void) | null
    >(null);
    const [createFolderAction, setCreateFolderAction] = useState<
        (() => void) | null
    >(null);
    const [uploadFolderAction, setUploadFolderAction] = useState<
        (() => void) | null
    >(null);
    const [folderBackAction, setFolderBackAction] = useState<
        (() => void) | null
    >(null);
    const [folderBreadcrumbs, setFolderBreadcrumbs] = useState<
        Array<{ label: string; onClick: () => void }>
    >([]);
    const loading =
        !collection || loadingByKind[kind] || !folderAvailable;
    const addCollectionLabel = kind === "templates" ? "Templates" : "Files";

    const handleAddDocumentsActionChange = useCallback(
        (action: (() => void) | null) => {
            setAddDocumentsAction(() => action);
        },
        [],
    );

    const handleCreateFolderActionChange = useCallback(
        (action: (() => void) | null) => {
            setCreateFolderAction(() => action);
        },
        [],
    );
    const handleUploadFolderActionChange = useCallback(
        (action: (() => void) | null) => {
            setUploadFolderAction(() => action);
        },
        [],
    );

    const handleFolderBackActionChange = useCallback(
        (action: (() => void) | null) => {
            setFolderBackAction(() => action);
        },
        [],
    );

    const handleFolderViewChange = useCallback(
        (path: DocTableFolderBreadcrumb[]) => {
            setFolderBreadcrumbs(
                path.map((folder) => ({
                    label: folder.name,
                    onClick: folder.onClick,
                })),
            );
        },
        [],
    );

    const handleExpandFolder = useCallback(
        (folderId: string) => loadFolderChildren(kind, folderId),
        [kind, loadFolderChildren],
    );

    const handleLoadMoreDocuments = useCallback(
        (parentId: string | null) => loadMoreDocuments(kind, parentId),
        [kind, loadMoreDocuments],
    );

  const handleServerQueryChange = useCallback((query: DocTableQuery) => {
    setTableQuery(query);
  }, []);

  const handleSelectAllMatching = useCallback(
    (query: DocTableQuery) =>
      listLibraryDocumentIds(kind, {
        search: query.search.trim() || undefined,
        fileType: query.fileType ?? undefined,
      }),
    [kind],
  );

  useEffect(() => {
    let cancelled = false;
    void getLibraryFilterOptions(kind)
      .then((options) => {
        if (!cancelled) setDocumentTypeOptions(options.fileTypes);
      })
      .catch(() => {
        if (!cancelled) setDocumentTypeOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const serverQueryActive =
    debouncedSearch.trim().length > 0 ||
    !!tableQuery.fileType ||
    !!tableQuery.sort;

  useEffect(() => {
    const requestVersion = ++serverQueryRequestRef.current;
    if (!serverQueryActive) {
      setServerDocuments(null);
      setServerQueryLoading(false);
      setServerQueryLoadingMore(false);
      setServerQueryHasMore(false);
      return;
    }

    const controller = new AbortController();
    setServerDocuments([]);
    setServerQueryLoading(true);
    setServerQueryLoadingMore(false);
    void searchLibraryDocuments(kind, {
      limit: DOCUMENT_PAGE_SIZE,
      search: debouncedSearch.trim() || undefined,
      fileType: tableQuery.fileType ?? undefined,
      sortKey: tableQuery.sort?.key,
      sortDirection: tableQuery.sort?.direction,
      signal: controller.signal,
    })
      .then((result) => {
        if (requestVersion !== serverQueryRequestRef.current) return;
        setServerDocuments(result.documents);
        setServerQueryHasMore(result.documentsHasMore);
      })
      .catch((error) => {
        if (
          !controller.signal.aborted &&
          requestVersion === serverQueryRequestRef.current
        ) {
          console.error("[library] failed to search", error);
          setServerDocuments([]);
          setServerQueryHasMore(false);
        }
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          requestVersion === serverQueryRequestRef.current
        ) {
          setServerQueryLoading(false);
        }
      });
    return () => controller.abort();
  }, [
    debouncedSearch,
    kind,
    serverQueryActive,
    serverQueryRefreshVersion,
    tableQuery.fileType,
    tableQuery.sort,
  ]);

  const handleLoadMoreServerDocuments = useCallback(async () => {
    if (
      !serverQueryActive ||
      !serverQueryHasMore ||
      serverQueryLoading ||
      serverQueryLoadingMore
    ) {
      return;
    }
    const requestVersion = serverQueryRequestRef.current;
    const offset = serverDocuments?.length ?? 0;
    setServerQueryLoadingMore(true);
    try {
      const result = await searchLibraryDocuments(kind, {
        limit: DOCUMENT_PAGE_SIZE,
        offset,
        search: debouncedSearch.trim() || undefined,
        fileType: tableQuery.fileType ?? undefined,
        sortKey: tableQuery.sort?.key,
        sortDirection: tableQuery.sort?.direction,
      });
      if (requestVersion !== serverQueryRequestRef.current) return;
      setServerDocuments((current) => {
        if (current === null) return result.documents;
        const existing = new Set(current.map((document) => document.id));
        return [
          ...current,
          ...result.documents.filter((document) => !existing.has(document.id)),
        ];
      });
      setServerQueryHasMore(result.documentsHasMore);
    } catch (error) {
      if (requestVersion === serverQueryRequestRef.current) {
        console.error("[library] failed to load more search results", error);
      }
    } finally {
      if (requestVersion === serverQueryRequestRef.current) {
        setServerQueryLoadingMore(false);
      }
    }
  }, [
    debouncedSearch,
    kind,
    serverDocuments?.length,
    serverQueryActive,
    serverQueryHasMore,
    serverQueryLoading,
    serverQueryLoadingMore,
    tableQuery.fileType,
    tableQuery.sort,
  ]);

    const operations = useMemo(
        () => ({
            uploadDocument: (file: File, folderId?: string | null) =>
                uploadLibraryDocument(kind, file, folderId),
            uploadDocuments: (
                files: Array<{
                    file: File;
                    folderId: string | null;
                    clientId: string;
                }>,
                options?: Parameters<typeof uploadLibraryDocuments>[2],
            ) =>
                uploadLibraryDocuments(
                    kind,
                    files.map(({ file, folderId, clientId }) => ({
                        file,
                        folderId,
                        clientId,
                    })),
                    options,
                ),
      refreshCollection: async () => {
        await loadLibrary(kind);
        setServerQueryRefreshVersion((current) => current + 1);
      },
            createFolder: (name: string, parentFolderId?: string | null) =>
                createLibraryFolder(kind, name, parentFolderId),
            resolveFolderPath: (
                segments: string[],
                baseFolderId: string | null,
                conflictResolution?: "error" | "reuse" | "rename",
            ) =>
                resolveLibraryFolderPath(
                    kind,
                    segments,
                    baseFolderId,
                    conflictResolution,
                ),
            renameFolder: (folderId: string, name: string) =>
                renameLibraryFolder(kind, folderId, name),
      deleteFolder: (folderId: string) => deleteLibraryFolder(kind, folderId),
            moveFolder: (folderId: string, parentFolderId: string | null) =>
                moveLibraryFolder(kind, folderId, parentFolderId),
            moveDocument: (documentId: string, folderId: string | null) =>
                moveLibraryDocument(kind, documentId, folderId),
            renameDocument: (documentId: string, filename: string) =>
                renameLibraryDocument(kind, documentId, filename),
      bulkDeleteDocuments: (documentIds: string[]) =>
        bulkDeleteLibraryDocuments(kind, documentIds),
        }),
        [kind, loadLibrary],
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    {
                        label: "Library",
                        onClick: () => router.push("/library"),
                    },
                    {
                        label: title,
                        onClick: () => router.push(collectionRootPath),
                    },
                    ...folderBreadcrumbs,
                ]}
                actionGroups={[
                    {
                        actions: [
                            {
                                type: "search",
                                value: search,
                onChange: (value) => setSearchForKind(kind, value),
                                placeholder: `Search ${title.toLowerCase()}...`,
                            },
                        ],
                    },
                    {
                        actions: [
                            {
                                icon: <Upload className="h-3.5 w-3.5" />,
                                iconOnly: true,
                                title: `Add ${addCollectionLabel}`,
                                onClick: addDocumentsAction ?? undefined,
                                disabled: !addDocumentsAction || loading,
                            },
                        ],
                    },
                ]}
            />

            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <TableToolbar
                    items={LIBRARY_TABS}
                    active={kind}
                    onChange={(next) =>
                        router.push(
                            next === "files" ? "/library" : "/library/templates",
                        )
                    }
                    actions={
                        <>
                            {folderBackAction && (
                                <TabPillButton onClick={folderBackAction}>
                                    <ChevronLeft className="h-3.5 w-3.5" />
                                    Back
                                </TabPillButton>
                            )}
                            <TabPillButton
                                onClick={uploadFolderAction ?? undefined}
                                disabled={!uploadFolderAction || loading}
                            >
                                <FolderUp className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">
                                    Upload folder
                                </span>
                            </TabPillButton>
                            <TabPillButton
                                onClick={createFolderAction ?? undefined}
                                disabled={!createFolderAction || loading}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">Folder</span>
                            </TabPillButton>
                        </>
                    }
                />
                <DocTable
                    scopeKey={kind}
                    documents={collection?.documents ?? []}
                    setDocuments={setDocuments}
                    folders={collection?.folders ?? []}
                    setFolders={setFolders}
                    loading={loading}
                    search={search}
                    operations={operations}
                    emptyStateTitle={title}
                    onAddDocumentsActionChange={handleAddDocumentsActionChange}
                    onUploadFolderActionChange={
                        handleUploadFolderActionChange
                    }
          onCreateFolderActionChange={handleCreateFolderActionChange}
                    onFolderViewBackActionChange={handleFolderBackActionChange}
                    onFolderViewChange={handleFolderViewChange}
                    folderViewId={folderId}
                    onFolderViewIdChange={handleFolderViewIdChange}
                    onExpandFolder={handleExpandFolder}
                    documentsHasMoreByLevel={documentsHasMoreByKind[kind]}
          loadingMoreDocumentsByLevel={loadingMoreDocumentsByKind[kind]}
                    onLoadMoreDocuments={handleLoadMoreDocuments}
          serverDocuments={serverDocuments}
          serverQueryLoading={serverQueryLoading}
          serverQueryHasMore={serverQueryHasMore}
          serverQueryLoadingMore={serverQueryLoadingMore}
          onLoadMoreServerDocuments={handleLoadMoreServerDocuments}
          onServerQueryChange={handleServerQueryChange}
          onSelectAllMatching={handleSelectAllMatching}
          documentTypeOptions={documentTypeOptions.map((fileType) => ({
            value: fileType,
            label: fileType.toUpperCase(),
          }))}
          autoLoadOnScroll
                    enableHeaderFilters
                    defaultSort={{ key: "updated", direction: "desc" }}
                />
            </div>
        </div>
    );
}
