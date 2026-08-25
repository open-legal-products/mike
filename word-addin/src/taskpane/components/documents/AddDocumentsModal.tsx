import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, Search, Upload, X } from "lucide-react";
import type { Document, LibraryFolder, Project } from "../../types";
import {
  getLibrary,
  getLibraryFolderChildren,
  getProjectDirectoryLevel,
  failedUploadMessage,
  listProjects,
  uploadStandaloneDocuments,
  type UploadProgress,
} from "../../api/mikeApi";
import {
  partitionSupportedDocumentFiles,
  SUPPORTED_DOCUMENT_ACCEPT,
} from "../../lib/documentUpload";
import { Modal } from "../primitives/Modal";
import { Spinner } from "../../../shared/ui/spinner";
import { TabPillButton } from "../../../shared/ui/tab-pill-button";
import {
  FileTypeIcon,
  ProjectSvgIcon,
  SubfolderSvgIcon,
} from "./DirectoryIcons";

type DirectoryTab = "files" | "templates" | "projects";

interface AddDocumentsModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (documents: Document[]) => void;
  initialSelectedDocuments?: Document[];
}

const TABS: { value: DirectoryTab; label: string }[] = [
  { value: "files", label: "Files" },
  { value: "templates", label: "Templates" },
  { value: "projects", label: "Projects" },
];

const DIRECTORY_GRID_CLASS =
  "grid grid-cols-[14px_14px_minmax(0,1fr)] items-center gap-1.5";
const DIRECTORY_PAGE_SIZE = 40;
const ROOT_LEVEL_KEY = "root";

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => merged.set(item.id, item));
  return [...merged.values()];
}

function DirectoryLoadMoreRow({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}): React.ReactElement | null {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasMore || loading || typeof IntersectionObserver === "undefined") {
      return;
    }
    const row = rowRef.current;
    if (!row) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        onLoadMore();
      },
      { rootMargin: "0px 0px 80px 0px" },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  if (!hasMore) return null;
  return (
    <div ref={rowRef} className="flex justify-center py-2">
      <button
        type="button"
        disabled={loading}
        onClick={onLoadMore}
        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] text-gray-500 hover:text-gray-900 disabled:opacity-60"
      >
        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
        {loading ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}

export function AddDocumentsModal({
  open,
  onClose,
  onSelect,
  initialSelectedDocuments = [],
}: AddDocumentsModalProps): React.ReactElement | null {
  const [activeTab, setActiveTab] = useState<DirectoryTab>("files");
  const [documents, setDocuments] = useState<Document[]>([]);
  const [libraryFolders, setLibraryFolders] = useState<LibraryFolder[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsHasMore, setProjectsHasMore] = useState(false);
  const [loadingMoreProjects, setLoadingMoreProjects] = useState(false);
  const [projectDocuments, setProjectDocuments] = useState<
    Record<string, Document[]>
  >({});
  const [projectFolders, setProjectFolders] = useState<
    Record<string, LibraryFolder[]>
  >({});
  const [loadedProjectLevels, setLoadedProjectLevels] = useState<Set<string>>(
    new Set(),
  );
  const [loadingProjectLevels, setLoadingProjectLevels] = useState<Set<string>>(
    new Set(),
  );
  const [projectHasMoreByLevel, setProjectHasMoreByLevel] = useState<
    Record<string, boolean>
  >({});
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [expandedProjectFolders, setExpandedProjectFolders] = useState<
    Set<string>
  >(new Set());
  const [expandedLibraryFolders, setExpandedLibraryFolders] = useState<
    Set<string>
  >(new Set());
  const [loadedLibraryFolderIds, setLoadedLibraryFolderIds] = useState<
    Set<string>
  >(new Set());
  const [loadingLibraryFolderIds, setLoadingLibraryFolderIds] = useState<
    Set<string>
  >(new Set());
  const [libraryHasMoreByLevel, setLibraryHasMoreByLevel] = useState<
    Record<string, boolean>
  >({});
  const [loadingMoreLibraryLevels, setLoadingMoreLibraryLevels] = useState<
    Set<string>
  >(new Set());
  const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploadingFilenames, setUploadingFilenames] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const initialSelectionKey = initialSelectedDocuments
    .map((document) => document.id)
    .join("|");

  useEffect(() => {
    if (!open) return;
    setActiveTab("files");
    setSearch("");
    setWarning(null);
    setError(null);
    setSelectedDocuments(initialSelectedDocuments);
    // The id key deliberately controls reseeding when the parent selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSelectionKey]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExpandedLibraryFolders(new Set());
    setExpandedProjects(new Set());
    setExpandedProjectFolders(new Set());
    setProjectDocuments({});
    setProjectFolders({});
    setLoadedProjectLevels(new Set());
    setLoadingProjectLevels(new Set());
    setProjectHasMoreByLevel({});
    setLoadedLibraryFolderIds(new Set());
    setLoadingLibraryFolderIds(new Set());
    setLibraryHasMoreByLevel({});
    setLoadingMoreLibraryLevels(new Set());
    setProjectsHasMore(false);
    setLoadingMoreProjects(false);

    const request =
      activeTab === "projects"
        ? listProjects({ limit: DIRECTORY_PAGE_SIZE + 1 }).then((items) => {
            if (!cancelled) {
              setProjects((items ?? []).slice(0, DIRECTORY_PAGE_SIZE));
              setProjectsHasMore((items ?? []).length > DIRECTORY_PAGE_SIZE);
            }
          })
        : getLibrary(activeTab, { limit: DIRECTORY_PAGE_SIZE }).then(
            (collection) => {
              if (!cancelled) {
                setLibraryFolders(collection.folders ?? []);
                setDocuments(
                  [...(collection.documents ?? [])].sort((a, b) =>
                    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
                  ),
                );
                setLibraryHasMoreByLevel({
                  [ROOT_LEVEL_KEY]: !!collection.documentsHasMore,
                });
              }
            },
          );

    request
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Failed to load documents.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, open]);

  const selectedIds = useMemo(
    () => new Set(selectedDocuments.map((document) => document.id)),
    [selectedDocuments],
  );
  const query = search.trim().toLowerCase();
  const filteredDocuments = query
    ? documents.filter((document) =>
        document.filename.toLowerCase().includes(query),
      )
    : documents;
  const filteredProjects = query
    ? projects.filter((project) =>
        [project.name, project.cm_number ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : projects;

  const toggleDocument = (document: Document): void => {
    setSelectedDocuments((current) => {
      if (current.some((item) => item.id === document.id)) {
        return current.filter((item) => item.id !== document.id);
      }
      return [...current, document];
    });
  };

  const toggleDocuments = (items: Document[]): void => {
    if (items.length === 0) return;
    setSelectedDocuments((current) => {
      const next = new Map(current.map((document) => [document.id, document]));
      const allSelected = items.every((document) => next.has(document.id));
      items.forEach((document) => {
        if (allSelected) next.delete(document.id);
        else next.set(document.id, document);
      });
      return [...next.values()];
    });
  };

  const loadProjectLevel = async (
    projectId: string,
    parentFolderId: string | null,
    loadMore = false,
  ): Promise<void> => {
    const levelKey = `${projectId}:${parentFolderId ?? ROOT_LEVEL_KEY}`;
    if (!loadMore && loadedProjectLevels.has(levelKey)) return;
    if (loadingProjectLevels.has(levelKey)) return;
    const offset = loadMore
      ? folderDocuments(projectDocuments[projectId] ?? [], parentFolderId)
          .length
      : 0;
    setLoadingProjectLevels((current) => new Set(current).add(levelKey));
    setError(null);
    try {
      const level = await getProjectDirectoryLevel(projectId, {
        parentFolderId,
        limit: DIRECTORY_PAGE_SIZE,
        offset,
      });
      setProjectDocuments((current) => ({
        ...current,
        [projectId]: mergeById(current[projectId] ?? [], level.documents),
      }));
      setProjectFolders((current) => ({
        ...current,
        [projectId]: mergeById(current[projectId] ?? [], level.folders),
      }));
      setLoadedProjectLevels((current) => new Set(current).add(levelKey));
      setProjectHasMoreByLevel((current) => ({
        ...current,
        [levelKey]: !!level.documentsHasMore,
      }));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Failed to load project documents.",
      );
    } finally {
      setLoadingProjectLevels((current) => {
        const next = new Set(current);
        next.delete(levelKey);
        return next;
      });
    }
  };

  const projectLevelKey = (
    projectId: string,
    parentFolderId: string | null,
  ): string => `${projectId}:${parentFolderId ?? ROOT_LEVEL_KEY}`;

  const toggleProject = async (projectId: string): Promise<void> => {
    if (expandedProjects.has(projectId)) {
      setExpandedProjects((current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
      return;
    }

    setExpandedProjects((current) => new Set(current).add(projectId));
    await loadProjectLevel(projectId, null);
  };

  const loadMoreProjects = async (): Promise<void> => {
    if (loadingMoreProjects || !projectsHasMore) return;
    setLoadingMoreProjects(true);
    try {
      const rows = await listProjects({
        limit: DIRECTORY_PAGE_SIZE + 1,
        offset: projects.length,
      });
      if (activeTabRef.current !== "projects") return;
      setProjects((current) =>
        mergeById(current, rows.slice(0, DIRECTORY_PAGE_SIZE)),
      );
      setProjectsHasMore(rows.length > DIRECTORY_PAGE_SIZE);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Failed to load projects.",
      );
    } finally {
      setLoadingMoreProjects(false);
    }
  };

  const handleUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    const { supported, unsupported } = partitionSupportedDocumentFiles(files);
    setWarning(
      unsupported.length === 0
        ? null
        : "Only PDF, Word, Excel, and PowerPoint files can be uploaded.",
    );
    if (supported.length === 0) return;

    setUploadingFilenames(supported.map((file) => file.name));
    setError(null);
    const addUploadedDocument = (document: Document) => {
      setDocuments((current) => [
        document,
        ...current.filter((item) => item.id !== document.id),
      ]);
      setSelectedDocuments((current) =>
        current.some((item) => item.id === document.id)
          ? current
          : [...current, document],
      );
      setActiveTab("files");
    };
    try {
      const outcomes = await uploadStandaloneDocuments(supported, {
        onProgress: (progress: UploadProgress<Document>) => {
          if (progress.status === "completed" || progress.status === "error") {
            setUploadingFilenames((current) =>
              current.filter((filename) => filename !== progress.filename),
            );
          }
          if (progress.status === "completed" && progress.result) {
            addUploadedDocument(progress.result);
          }
        },
      });
      const uploaded = outcomes.flatMap((outcome) =>
        outcome.status === "completed" && outcome.result
          ? [outcome.result]
          : [],
      );
      if (uploaded.length > 0) {
        uploaded.forEach(addUploadedDocument);
      }
      if (outcomes.some((outcome) => outcome.status === "error")) {
        setError(failedUploadMessage(outcomes));
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Documents could not be uploaded. Please try again.",
      );
    } finally {
      setUploadingFilenames([]);
    }
  };

  const documentFolderId = (document: Document): string | null =>
    document.folder_id ?? document.library_folder_id ?? null;

  const childFolders = (
    folders: LibraryFolder[],
    parentId: string | null,
  ): LibraryFolder[] =>
    folders.filter((folder) => (folder.parent_folder_id ?? null) === parentId);

  const folderDocuments = (
    items: Document[],
    folderId: string | null,
  ): Document[] =>
    items.filter((document) => documentFolderId(document) === folderId);

  const collectFolderDocuments = (folderId: string): Document[] => [
    ...folderDocuments(documents, folderId),
    ...childFolders(libraryFolders, folderId).flatMap((folder) =>
      collectFolderDocuments(folder.id),
    ),
  ];

  const folderTreeIsLoaded = (folderId: string): boolean =>
    loadedLibraryFolderIds.has(folderId) &&
    !libraryHasMoreByLevel[folderId] &&
    childFolders(libraryFolders, folderId).every((folder) =>
      folderTreeIsLoaded(folder.id),
    );

  const collectProjectFolderDocuments = (
    projectId: string,
    folderId: string,
  ): Document[] => {
    const folders = projectFolders[projectId] ?? [];
    const items = projectDocuments[projectId] ?? [];
    return [
      ...folderDocuments(items, folderId),
      ...childFolders(folders, folderId).flatMap((folder) =>
        collectProjectFolderDocuments(projectId, folder.id),
      ),
    ];
  };

  const projectFolderTreeIsLoaded = (
    projectId: string,
    folderId: string,
  ): boolean => {
    const folders = projectFolders[projectId] ?? [];
    const levelKey = projectLevelKey(projectId, folderId);
    return (
      loadedProjectLevels.has(levelKey) &&
      !projectHasMoreByLevel[levelKey] &&
      childFolders(folders, folderId).every((folder) =>
        projectFolderTreeIsLoaded(projectId, folder.id),
      )
    );
  };

  const toggleProjectFolder = async (
    projectId: string,
    folderId: string,
  ): Promise<void> => {
    const expandedKey = projectLevelKey(projectId, folderId);
    const opening = !expandedProjectFolders.has(expandedKey);
    setExpandedProjectFolders((current) => {
      const next = new Set(current);
      if (next.has(expandedKey)) next.delete(expandedKey);
      else next.add(expandedKey);
      return next;
    });
    if (opening) await loadProjectLevel(projectId, folderId);
  };

  const loadLibraryFolderLevel = async (
    kind: "files" | "templates",
    folderId: string,
    loadMore = false,
  ): Promise<void> => {
    if (!loadMore && loadedLibraryFolderIds.has(folderId)) return;
    if (loadingLibraryFolderIds.has(folderId)) return;
    setLoadingLibraryFolderIds((current) => new Set(current).add(folderId));
    if (loadMore) {
      setLoadingMoreLibraryLevels((current) => new Set(current).add(folderId));
    }
    try {
      const offset = loadMore ? folderDocuments(documents, folderId).length : 0;
      const level = await getLibraryFolderChildren(kind, folderId, {
        limit: DIRECTORY_PAGE_SIZE,
        offset,
      });

      if (activeTabRef.current === kind) {
        setDocuments((current) => mergeById(current, level.documents));
        setLibraryFolders((current) => mergeById(current, level.folders));
        setLoadedLibraryFolderIds((current) => new Set(current).add(folderId));
        setLibraryHasMoreByLevel((current) => ({
          ...current,
          [folderId]: !!level.documentsHasMore,
        }));
      }
    } finally {
      setLoadingLibraryFolderIds((current) => {
        const next = new Set(current);
        next.delete(folderId);
        return next;
      });
      setLoadingMoreLibraryLevels((current) => {
        const next = new Set(current);
        next.delete(folderId);
        return next;
      });
    }
  };

  const toggleLibraryFolder = async (folderId: string): Promise<void> => {
    const opening = !expandedLibraryFolders.has(folderId);
    setExpandedLibraryFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
    if (
      !opening ||
      loadedLibraryFolderIds.has(folderId) ||
      activeTab === "projects"
    ) {
      return;
    }
    try {
      await loadLibraryFolderLevel(activeTab, folderId);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Failed to load folder documents.",
      );
    }
  };

  const loadMoreLibraryRoot = async (): Promise<void> => {
    if (activeTab === "projects") return;
    if (loadingMoreLibraryLevels.has(ROOT_LEVEL_KEY)) return;
    const kind = activeTab;
    setLoadingMoreLibraryLevels((current) =>
      new Set(current).add(ROOT_LEVEL_KEY),
    );
    try {
      const level = await getLibrary(kind, {
        limit: DIRECTORY_PAGE_SIZE,
        offset: folderDocuments(documents, null).length,
      });
      if (activeTabRef.current !== kind) return;
      setDocuments((current) => mergeById(current, level.documents));
      setLibraryFolders((current) => mergeById(current, level.folders));
      setLibraryHasMoreByLevel((current) => ({
        ...current,
        [ROOT_LEVEL_KEY]: !!level.documentsHasMore,
      }));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Failed to load documents.",
      );
    } finally {
      setLoadingMoreLibraryLevels((current) => {
        const next = new Set(current);
        next.delete(ROOT_LEVEL_KEY);
        return next;
      });
    }
  };

  const renderDocument = (document: Document, depth = 0) => {
    const selected = selectedIds.has(document.id);
    return (
      <button
        key={document.id}
        type="button"
        aria-pressed={selected}
        onClick={() => toggleDocument(document)}
        style={{ paddingLeft: 8 + depth * 16 }}
        className={`w-full min-w-0 rounded-md py-2 pr-2 text-left text-xs transition-all ${DIRECTORY_GRID_CLASS} ${
          selected
            ? "bg-gray-200 text-gray-900"
            : "text-gray-700 hover:bg-gray-100"
        }`}
      >
        <span
          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
            selected ? "border-gray-900 bg-gray-900" : "border-gray-300"
          }`}
        >
          {selected && <Check className="h-2.5 w-2.5 text-white" />}
        </span>
        <FileTypeIcon fileType={document.file_type ?? document.filename} />
        <span className="min-w-0 truncate">{document.filename}</span>
      </button>
    );
  };

  function renderFolderRows(
    folders: LibraryFolder[],
    parentId: string | null,
    depth = 0,
  ): React.ReactNode {
    return childFolders(folders, parentId).map((folder) => {
      const expanded = expandedLibraryFolders.has(folder.id);
      const items = collectFolderDocuments(folder.id);
      const directItems = folderDocuments(documents, folder.id);
      const directChildFolders = childFolders(libraryFolders, folder.id);
      const treeLoaded = folderTreeIsLoaded(folder.id);
      const folderLoading = loadingLibraryFolderIds.has(folder.id);
      const allSelected =
        treeLoaded &&
        items.length > 0 &&
        items.every((document) => selectedIds.has(document.id));
      const someSelected =
        !allSelected && items.some((document) => selectedIds.has(document.id));
      return (
        <div key={folder.id}>
          <button
            type="button"
            onClick={() => void toggleLibraryFolder(folder.id)}
            style={{ paddingLeft: 8 + depth * 16 }}
            className={`w-full rounded-md py-2 pr-2 text-left text-xs text-gray-700 transition-all hover:bg-gray-100 ${DIRECTORY_GRID_CLASS}`}
          >
            <span
              role="checkbox"
              aria-checked={someSelected ? "mixed" : allSelected}
              aria-disabled={!treeLoaded || items.length === 0}
              aria-label={`Select all files in ${folder.name}`}
              onClick={(event) => {
                event.stopPropagation();
                if (!treeLoaded || items.length === 0) return;
                toggleDocuments(items);
              }}
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                allSelected || someSelected
                  ? "border-gray-900 bg-gray-900"
                  : !treeLoaded || items.length === 0
                    ? "border-gray-200 bg-gray-50"
                    : "border-gray-300"
              }`}
            >
              {allSelected && <Check className="h-2.5 w-2.5 text-white" />}
              {someSelected && <span className="h-px w-2 bg-white" />}
            </span>
            {folderLoading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-400" />
            ) : (
              <SubfolderSvgIcon
                open={expanded}
                className="h-3.5 w-3.5 shrink-0"
              />
            )}
            <span className="min-w-0 truncate font-medium">{folder.name}</span>
          </button>
          {expanded && (
            <div>
              {renderFolderRows(folders, folder.id, depth + 1)}
              {directItems.map((document) =>
                renderDocument(document, depth + 1),
              )}
              <div style={{ paddingLeft: 24 + depth * 16 }}>
                <DirectoryLoadMoreRow
                  hasMore={!!libraryHasMoreByLevel[folder.id]}
                  loading={loadingMoreLibraryLevels.has(folder.id)}
                  onLoadMore={() => {
                    if (activeTab !== "projects") {
                      void loadLibraryFolderLevel(activeTab, folder.id, true);
                    }
                  }}
                />
              </div>
              {loadedLibraryFolderIds.has(folder.id) &&
                directItems.length === 0 &&
                directChildFolders.length === 0 && (
                  <p
                    className="py-1 text-xs text-gray-400"
                    style={{ paddingLeft: 40 + depth * 16 }}
                  >
                    Empty
                  </p>
                )}
            </div>
          )}
        </div>
      );
    });
  }

  function renderProjectFolderRows(
    projectId: string,
    parentId: string | null,
    depth = 0,
  ): React.ReactNode {
    const folders = projectFolders[projectId] ?? [];
    const projectItems = projectDocuments[projectId] ?? [];
    return childFolders(folders, parentId).map((folder) => {
      const expandedKey = projectLevelKey(projectId, folder.id);
      const expanded = expandedProjectFolders.has(expandedKey);
      const items = collectProjectFolderDocuments(projectId, folder.id);
      const directItems = folderDocuments(projectItems, folder.id);
      const directChildFolders = childFolders(folders, folder.id);
      const treeLoaded = projectFolderTreeIsLoaded(projectId, folder.id);
      const levelKey = projectLevelKey(projectId, folder.id);
      const folderLoading = loadingProjectLevels.has(levelKey);
      const allSelected =
        treeLoaded &&
        items.length > 0 &&
        items.every((document) => selectedIds.has(document.id));
      const someSelected =
        !allSelected && items.some((document) => selectedIds.has(document.id));

      return (
        <div key={folder.id}>
          <button
            type="button"
            onClick={() => void toggleProjectFolder(projectId, folder.id)}
            style={{ paddingLeft: 8 + depth * 16 }}
            className={`w-full rounded-md py-2 pr-2 text-left text-xs text-gray-700 transition-all hover:bg-gray-100 ${DIRECTORY_GRID_CLASS}`}
          >
            <span
              role="checkbox"
              aria-checked={someSelected ? "mixed" : allSelected}
              aria-disabled={!treeLoaded || items.length === 0}
              aria-label={`Select all files in ${folder.name}`}
              onClick={(event) => {
                event.stopPropagation();
                if (!treeLoaded || items.length === 0) return;
                toggleDocuments(items);
              }}
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                allSelected || someSelected
                  ? "border-gray-900 bg-gray-900"
                  : !treeLoaded || items.length === 0
                    ? "border-gray-200 bg-gray-50"
                    : "border-gray-300"
              }`}
            >
              {allSelected && <Check className="h-2.5 w-2.5 text-white" />}
              {someSelected && <span className="h-px w-2 bg-white" />}
            </span>
            {folderLoading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-400" />
            ) : (
              <SubfolderSvgIcon
                open={expanded}
                className="h-3.5 w-3.5 shrink-0"
              />
            )}
            <span className="min-w-0 truncate font-medium">{folder.name}</span>
          </button>
          {expanded && (
            <div>
              {renderProjectFolderRows(projectId, folder.id, depth + 1)}
              {directItems.map((document) =>
                renderDocument(document, depth + 1),
              )}
              <div style={{ paddingLeft: 24 + depth * 16 }}>
                <DirectoryLoadMoreRow
                  hasMore={!!projectHasMoreByLevel[levelKey]}
                  loading={folderLoading}
                  onLoadMore={() =>
                    void loadProjectLevel(projectId, folder.id, true)
                  }
                />
              </div>
              {loadedProjectLevels.has(levelKey) &&
                directItems.length === 0 &&
                directChildFolders.length === 0 && (
                  <p
                    className="py-1 text-xs text-gray-400"
                    style={{ paddingLeft: 40 + depth * 16 }}
                  >
                    Empty
                  </p>
                )}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Documents"
      secondaryAction={{
        label: uploadingFilenames.length > 0 ? "Uploading…" : "Upload",
        icon:
          uploadingFilenames.length > 0 ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          ),
        onClick: () => fileInputRef.current?.click(),
        disabled: uploadingFilenames.length > 0,
      }}
      primaryAction={{
        label: "Confirm",
        disabled:
          selectedDocuments.length === 0 || uploadingFilenames.length > 0,
        onClick: () => {
          onSelect(selectedDocuments);
          onClose();
        },
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={SUPPORTED_DOCUMENT_ACCEPT}
        multiple
        className="hidden"
        aria-label="Upload documents"
        onChange={(event) => void handleUpload(event)}
      />

      {(warning || error) && (
        <div
          role="alert"
          className="mb-2 flex items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-gray-900"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />
          <span className="min-w-0 flex-1">{warning ?? error}</span>
          <button
            type="button"
            onClick={() => {
              setWarning(null);
              setError(null);
            }}
            className="shrink-0 rounded p-0.5 text-gray-600 hover:bg-gray-100"
            aria-label="Dismiss warning"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <label className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-white/70 bg-white/70 px-3 text-gray-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_7px_rgba(15,23,42,0.05)]">
        <Search className="h-3.5 w-3.5" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search..."
          autoFocus
          className="min-w-0 flex-1 border-0 bg-transparent text-xs text-gray-800 outline-none placeholder:text-gray-400"
        />
      </label>

      <div className="my-3 flex items-center justify-between gap-2">
        <div
          data-testid="document-tabs-scroll"
          className="-mx-2 -my-2 flex min-w-0 items-center gap-1 overflow-x-auto px-2 py-2"
        >
          {TABS.map((tab) => (
            <TabPillButton
              key={tab.value}
              active={activeTab === tab.value}
              onClick={() => setActiveTab(tab.value)}
              className="shrink-0 px-2.5"
            >
              {tab.label}
            </TabPillButton>
          ))}
        </div>
        {selectedDocuments.length > 0 && (
          <span className="shrink-0 text-[11px] text-gray-400">
            {selectedDocuments.length} selected
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Loading documents…" />
            </div>
          ) : activeTab === "projects" ? (
            filteredProjects.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-400">
                {query ? "No matches found" : "No projects yet"}
              </p>
            ) : (
              <div className="space-y-px">
                {filteredProjects.map((project) => {
                  const expanded = expandedProjects.has(project.id);
                  const items = projectDocuments[project.id] ?? [];
                  const folders = projectFolders[project.id] ?? [];
                  const rootItems = folderDocuments(items, null);
                  const rootKey = projectLevelKey(project.id, null);
                  const projectLoading = loadingProjectLevels.has(rootKey);
                  const projectLoaded = loadedProjectLevels.has(rootKey);
                  const projectSelectionReady =
                    projectLoaded &&
                    !projectHasMoreByLevel[rootKey] &&
                    childFolders(folders, null).every((folder) =>
                      projectFolderTreeIsLoaded(project.id, folder.id),
                    );
                  const allSelected =
                    projectSelectionReady &&
                    items.length > 0 &&
                    items.every((document) => selectedIds.has(document.id));
                  const someSelected =
                    !allSelected &&
                    items.some((document) => selectedIds.has(document.id));
                  return (
                    <div key={project.id}>
                      <button
                        type="button"
                        onClick={() => void toggleProject(project.id)}
                        className={`w-full rounded-md px-2 py-2.5 text-left text-xs text-gray-700 transition-all hover:bg-gray-100 ${DIRECTORY_GRID_CLASS}`}
                      >
                        <span
                          role="checkbox"
                          aria-checked={someSelected ? "mixed" : allSelected}
                          aria-disabled={
                            !projectSelectionReady || items.length === 0
                          }
                          aria-label={`Select all files in ${project.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!projectSelectionReady || items.length === 0)
                              return;
                            toggleDocuments(items);
                          }}
                          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                            allSelected || someSelected
                              ? "border-gray-900 bg-gray-900"
                              : !projectSelectionReady || items.length === 0
                                ? "border-gray-200 bg-gray-50"
                                : "border-gray-300"
                          }`}
                        >
                          {projectLoading ? (
                            <Loader2 className="h-2.5 w-2.5 animate-spin text-gray-400" />
                          ) : allSelected ? (
                            <Check className="h-2.5 w-2.5 text-white" />
                          ) : someSelected ? (
                            <span className="h-px w-2 bg-white" />
                          ) : null}
                        </span>
                        <ProjectSvgIcon
                          open={expanded}
                          className="h-3.5 w-3.5 shrink-0"
                        />
                        <span className="min-w-0 truncate font-medium">
                          {project.name}
                          {project.cm_number && (
                            <span className="ml-1 font-normal text-gray-400">
                              #{project.cm_number}
                            </span>
                          )}
                        </span>
                      </button>
                      {expanded &&
                        (projectLoading && !projectLoaded ? (
                          <div className="flex justify-center py-3">
                            <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                          </div>
                        ) : (
                          <div>
                            {!query &&
                              renderProjectFolderRows(project.id, null, 1)}
                            {(query ? items : rootItems)
                              .filter(
                                (document) =>
                                  !query ||
                                  document.filename
                                    .toLowerCase()
                                    .includes(query),
                              )
                              .map((document) => renderDocument(document, 1))}
                            {!query && (
                              <DirectoryLoadMoreRow
                                hasMore={!!projectHasMoreByLevel[rootKey]}
                                loading={projectLoading}
                                onLoadMore={() =>
                                  void loadProjectLevel(project.id, null, true)
                                }
                              />
                            )}
                            {projectLoaded &&
                              rootItems.length === 0 &&
                              childFolders(folders, null).length === 0 && (
                                <p className="py-2 pl-9 text-xs text-gray-400">
                                  No documents
                                </p>
                              )}
                          </div>
                        ))}
                    </div>
                  );
                })}
                {!query && (
                  <DirectoryLoadMoreRow
                    hasMore={projectsHasMore}
                    loading={loadingMoreProjects}
                    onLoadMore={() => void loadMoreProjects()}
                  />
                )}
              </div>
            )
          ) : (
            <>
              {activeTab === "files" &&
                uploadingFilenames.map((filename) => (
                  <div
                    key={filename}
                    className={`px-2 py-2 text-xs text-gray-400 ${DIRECTORY_GRID_CLASS}`}
                  >
                    <span className="h-3.5 w-3.5 rounded border border-gray-300" />
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span className="min-w-0 truncate">{filename}</span>
                  </div>
                ))}
              {query ? (
                filteredDocuments.map((document) => renderDocument(document))
              ) : (
                <>
                  {renderFolderRows(libraryFolders, null)}
                  {folderDocuments(documents, null).map((document) =>
                    renderDocument(document),
                  )}
                  <DirectoryLoadMoreRow
                    hasMore={!!libraryHasMoreByLevel[ROOT_LEVEL_KEY]}
                    loading={loadingMoreLibraryLevels.has(ROOT_LEVEL_KEY)}
                    onLoadMore={() => void loadMoreLibraryRoot()}
                  />
                </>
              )}
              {filteredDocuments.length === 0 &&
                libraryFolders.length === 0 &&
                uploadingFilenames.length === 0 && (
                  <p className="py-8 text-center text-sm text-gray-400">
                    {query ? "No matches found" : `No ${activeTab} yet`}
                  </p>
                )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
