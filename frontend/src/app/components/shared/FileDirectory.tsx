"use client";

import {
  type ReactNode,
  type UIEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2 } from "lucide-react";
import type { Document, LibraryFolder, Project } from "./types";
import { FileTypeIcon } from "./FileTypeIcon";
import { ProjectSvgIcon, SubfolderSvgIcon } from "./FolderSvgIcon";
import { SearchBar } from "@/app/components/ui/search-bar";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { SkeletonLine } from "./TablePrimitive";
import { TableLoadMoreRow } from "./TableLoadMoreRow";
import { useDirectoryData, type DirectoryTab } from "./useDirectoryData";
import { useDebouncedValue } from "@/app/hooks/useDebouncedValue";
import {
  searchLibraryDocuments,
  searchProjectDirectory,
} from "@/app/lib/mikeApi";
import {
    LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
    LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS,
} from "@/app/components/ui/liquid-surface";

type DirectoryFolder = Pick<
    LibraryFolder,
    "id" | "name" | "parent_folder_id" | "created_at"
>;

const DIRECTORY_GRID_CLASS =
    "grid grid-cols-[14px_14px_minmax(0,1fr)_48px_84px_64px] items-center gap-2";
const DIRECTORY_ROW_ACTION_CLASS =
    "col-span-5 grid min-w-0 grid-cols-[14px_minmax(0,1fr)_48px_84px_64px] items-center gap-2 text-left";
const DIRECTORY_CHECKBOX_CLASS =
    "h-2.5 w-2.5 shrink-0 justify-self-center cursor-pointer rounded border-gray-200 accent-black disabled:cursor-not-allowed";

const DIRECTORY_TABS: { value: DirectoryTab; label: string }[] = [
    { value: "files", label: "Files" },
    { value: "templates", label: "Templates" },
    { value: "projects", label: "Projects" },
];
const ALL_DIRECTORY_TAB_VALUES = DIRECTORY_TABS.map((tab) => tab.value);

const EMPTY_DOCUMENTS: Document[] = [];
const EMPTY_FOLDERS: LibraryFolder[] = [];
const EMPTY_FOLDER_IDS: Record<"files" | "templates", Set<string>> = {
  files: new Set<string>(),
  templates: new Set<string>(),
};
const EMPTY_LEVEL_STATE: Record<
  "files" | "templates",
  Record<string, boolean>
> = { files: {}, templates: {} };
const DIRECTORY_SEARCH_PAGE_SIZE = 40;

function DirectorySelectionCheckbox({
  checked,
  disabled,
  indeterminate,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  indeterminate: boolean;
  label: string;
  onChange: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      className={DIRECTORY_CHECKBOX_CLASS}
    />
  );
}

function mergeDirectoryRows<T extends { id: string }>(current: T[], next: T[]) {
  const rows = new Map(current.map((row) => [row.id, row]));
  next.forEach((row) => rows.set(row.id, row));
  return [...rows.values()];
}

function formatDate(iso: string | null) {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

function formatBytes(bytes: number | null | undefined) {
    if (bytes == null) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function versionLabel(doc: Document) {
    const n = doc.active_version_number ?? doc.latest_version_number;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? `${n}` : null;
}

export function DocFileIcon({ fileType }: { fileType: string | null }) {
    return <FileTypeIcon fileType={fileType} className="h-3.5 w-3.5" />;
}

interface FileDirectoryProps {
    documents?: Document[];
    loading?: boolean;
    selectedDocuments: Document[];
    onChange: (documents: Document[]) => void;
    uploadingFilenames?: string[];
    showTabs: boolean;
    initialTab?: DirectoryTab;
    tabs?: readonly DirectoryTab[];
    excludeProjectId?: string;
    folders?: DirectoryFolder[];
  onExpandFolder?: (folderId: string) => void | Promise<void>;
  documentsHasMoreByFolder?: Record<string, boolean>;
  loadingFolderIds?: Set<string>;
  loadingMoreFolderIds?: Set<string>;
  loadedFolderIds?: Set<string>;
  onLoadMoreFolderDocuments?: (folderId: string) => void | Promise<void>;
  documentLimitByLevel?: Record<string, number>;
  rootDocumentsHasMore?: boolean;
  loadingMoreRootDocuments?: boolean;
  onLoadMoreRootDocuments?: () => void | Promise<void>;
  /** Documents already attached to the target resource. They remain visible
   * and checked, but cannot be toggled again. */
  disabledDocumentIds?: ReadonlySet<string>;
}

export function FileDirectory({
    documents = EMPTY_DOCUMENTS,
    loading: externalLoading = false,
    selectedDocuments,
    onChange,
    uploadingFilenames = [],
    showTabs,
    initialTab = "files",
    tabs = ALL_DIRECTORY_TAB_VALUES,
    excludeProjectId,
    folders = EMPTY_FOLDERS,
  onExpandFolder,
  documentsHasMoreByFolder = {},
  loadingFolderIds: externalLoadingFolderIds = new Set<string>(),
  loadingMoreFolderIds: externalLoadingMoreFolderIds = new Set<string>(),
  loadedFolderIds: externalLoadedFolderIds = new Set<string>(),
  onLoadMoreFolderDocuments,
  documentLimitByLevel = {},
  rootDocumentsHasMore = false,
  loadingMoreRootDocuments = false,
  onLoadMoreRootDocuments,
  disabledDocumentIds,
}: FileDirectoryProps) {
  const autoLoadTriggeredRef = useRef(false);
    const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
        new Set(),
    );
    const [expandedLibraryFolders, setExpandedLibraryFolders] = useState<
        Set<string>
    >(new Set());
    const initialDirectoryTab = tabs.includes(initialTab)
        ? initialTab
        : (tabs[0] ?? "files");
    const availableTabs = DIRECTORY_TABS.filter((tab) =>
        tabs.includes(tab.value),
    );
    const [selectedTab, setSelectedTab] =
        useState<DirectoryTab>(initialDirectoryTab);

    // Follow initialTab changes so keep-mounted parents (which never remount
    // this component) can still steer the starting tab per open.
    useEffect(() => {
        setSelectedTab(initialDirectoryTab);
    }, [initialDirectoryTab]);
    const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const [searchDocuments, setSearchDocuments] = useState<Document[] | null>(
    null,
  );
  const [searchProjects, setSearchProjects] = useState<Project[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchHasMore, setSearchHasMore] = useState(false);
    const {
        loadingTabs,
        standaloneDocuments,
        templateDocuments,
        fileFolders: loadedFileFolders,
        templateFolders: loadedTemplateFolders,
        projects,
    projectsHasMore = false,
    loadingMoreProjects = false,
    loadedProjectLevels = new Set<string>(),
    loadingProjectLevels = new Set<string>(),
    projectDocumentsHasMoreByLevel = {},
    loadedFolderIds = EMPTY_FOLDER_IDS,
    loadingFolderIds = EMPTY_FOLDER_IDS,
    documentsHasMoreByLevel = EMPTY_LEVEL_STATE,
    loadingMoreDocumentsByLevel = EMPTY_LEVEL_STATE,
        loadTab,
    loadFolderChildren = async () => {},
    loadMoreLibraryDocuments = async () => {},
    loadMoreProjects = async () => {},
    loadProjectLevel = async () => {},
    loadMoreProjectDocuments = async () => {},
    } = useDirectoryData(showTabs, initialDirectoryTab);

  useEffect(() => {
    const term = debouncedSearch.trim();
    if (!showTabs || !term) {
      setSearchDocuments(null);
      setSearchProjects(null);
      setSearchLoading(false);
      setSearchHasMore(false);
      return;
    }
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchDocuments(null);
    setSearchProjects(null);
    const request =
      selectedTab === "projects"
        ? searchProjectDirectory({
            search: term,
            limit: DIRECTORY_SEARCH_PAGE_SIZE + 1,
            signal: controller.signal,
          }).then((rows) => {
            setSearchProjects(rows.slice(0, DIRECTORY_SEARCH_PAGE_SIZE));
            setSearchHasMore(rows.length > DIRECTORY_SEARCH_PAGE_SIZE);
          })
        : searchLibraryDocuments(selectedTab, {
            search: term,
            limit: DIRECTORY_SEARCH_PAGE_SIZE + 1,
            signal: controller.signal,
          }).then((result) => {
            setSearchDocuments(result.documents.slice(0, DIRECTORY_SEARCH_PAGE_SIZE));
            setSearchHasMore(result.documents.length > DIRECTORY_SEARCH_PAGE_SIZE || result.documentsHasMore);
          });
    void request
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.error("[file-directory] search failed", error);
        setSearchDocuments([]);
        setSearchProjects([]);
        setSearchHasMore(false);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearchLoading(false);
      });
    return () => controller.abort();
  }, [debouncedSearch, selectedTab, showTabs]);

  async function loadMoreSearchResults() {
    const term = debouncedSearch.trim();
    if (!term || searchLoading || !searchHasMore) return;
    setSearchLoading(true);
    try {
      if (selectedTab === "projects") {
        const offset = searchProjects?.length ?? 0;
        const rows = await searchProjectDirectory({
          search: term,
          limit: DIRECTORY_SEARCH_PAGE_SIZE + 1,
          offset,
        });
        const page = rows.slice(0, DIRECTORY_SEARCH_PAGE_SIZE);
        setSearchProjects((current) =>
          mergeDirectoryRows(current ?? [], page),
        );
        setSearchHasMore(rows.length > DIRECTORY_SEARCH_PAGE_SIZE);
      } else {
        const offset = searchDocuments?.length ?? 0;
        const result = await searchLibraryDocuments(selectedTab, {
          search: term,
          limit: DIRECTORY_SEARCH_PAGE_SIZE,
          offset,
        });
        setSearchDocuments((current) =>
          mergeDirectoryRows(current ?? [], result.documents),
        );
        setSearchHasMore(result.documentsHasMore);
      }
    } finally {
      setSearchLoading(false);
    }
  }

    useEffect(() => {
        if (
            !showTabs ||
            initialDirectoryTab === "templates" ||
            !tabs.includes("templates")
        )
            return;
        void loadTab("templates");
    }, [initialDirectoryTab, showTabs, loadTab, tabs]);
    const directoryStandaloneDocs = useMemo(
        () =>
            showTabs
                ? [
                      ...documents.filter(
                          (doc) =>
                              !standaloneDocuments.some(
                                  (loadedDoc) => loadedDoc.id === doc.id,
                              ),
                      ),
                      ...standaloneDocuments,
                  ]
                : documents,
        [documents, showTabs, standaloneDocuments],
    );
  const directoryTemplateDocs = showTabs ? templateDocuments : EMPTY_DOCUMENTS;
  const directoryFileFolders = showTabs ? loadedFileFolders : folders;
    const directoryTemplateFolders = showTabs
        ? loadedTemplateFolders
        : EMPTY_FOLDERS;
    const localDirectoryProjects = useMemo(
        () =>
            showTabs
        ? projects.filter((project) => project.id !== excludeProjectId)
                : [],
        [excludeProjectId, projects, showTabs],
    );
    const selectedIds = useMemo(
        () => new Set(selectedDocuments.map((document) => document.id)),
        [selectedDocuments],
    );
    const checkedIds = useMemo(() => {
        const next = new Set(selectedIds);
        disabledDocumentIds?.forEach((id) => next.add(id));
        return next;
    }, [disabledDocumentIds, selectedIds]);

    const q = search.trim().toLowerCase();
    const visibleStandaloneDocs = q
    ? showTabs && selectedTab === "files" && searchDocuments !== null
      ? searchDocuments
      : directoryStandaloneDocs.filter((doc) =>
              doc.filename.toLowerCase().includes(q),
          )
        : directoryStandaloneDocs;
    const visibleUploadingFilenames = q
        ? uploadingFilenames.filter((filename) =>
              filename.toLowerCase().includes(q),
          )
        : uploadingFilenames;
    const visibleTemplateDocs = q
    ? showTabs && selectedTab === "templates" && searchDocuments !== null
      ? searchDocuments
      : directoryTemplateDocs.filter((doc) =>
              doc.filename.toLowerCase().includes(q),
          )
        : directoryTemplateDocs;
    const visibleDirectoryProjects = q
    ? (searchProjects ??
      localDirectoryProjects
              .map((project) => {
                  const docs = project.documents ?? [];
                  const projectMatches =
                      project.name.toLowerCase().includes(q) ||
                      (project.cm_number ?? "").toLowerCase().includes(q);
                  return {
                      ...project,
                      documents: projectMatches
                          ? docs
              : docs.filter((doc) => doc.filename.toLowerCase().includes(q)),
                  };
              })
              .filter((project) => {
                  const docs = project.documents ?? [];
                  return (
                      docs.length > 0 ||
                      project.name.toLowerCase().includes(q) ||
                      (project.cm_number ?? "").toLowerCase().includes(q)
                  );
        }))
        : localDirectoryProjects;
    const activeTab = showTabs ? selectedTab : "files";
    const activeLoading = showTabs
    ? !!loadingTabs[activeTab] || (q.length > 0 && searchLoading)
        : externalLoading;
    const hasVisibleFiles =
    visibleStandaloneDocs.length > 0 || visibleUploadingFilenames.length > 0;
    const hasVisibleProjects = visibleDirectoryProjects.length > 0;
    const hasVisibleTemplates = visibleTemplateDocs.length > 0;
    const activeTabHasNoResults =
        q &&
        ((activeTab === "files" && !hasVisibleFiles) ||
            (activeTab === "projects" && !hasVisibleProjects) ||
            (activeTab === "templates" && !hasVisibleTemplates));
  const activePageLoadingMore = q
    ? searchLoading
    : activeTab === "projects"
      ? loadingMoreProjects
      : activeTab === "templates"
        ? !!loadingMoreDocumentsByLevel.templates.root
        : showTabs
          ? !!loadingMoreDocumentsByLevel.files.root
          : loadingMoreRootDocuments;

  useEffect(() => {
    if (!activePageLoadingMore) autoLoadTriggeredRef.current = false;
  }, [activePageLoadingMore]);

  useEffect(() => {
    autoLoadTriggeredRef.current = false;
  }, [activeTab, q]);

  function handleDirectoryScroll(event: UIEvent<HTMLDivElement>) {
    if (autoLoadTriggeredRef.current) return;
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom > 80) return;

    if (q) {
      if (!searchHasMore || searchLoading) return;
      autoLoadTriggeredRef.current = true;
      void loadMoreSearchResults();
      return;
    }

    if (activeTab === "projects") {
      if (!projectsHasMore || loadingMoreProjects) return;
      autoLoadTriggeredRef.current = true;
      void loadMoreProjects();
      return;
    }

    if (activeTab === "templates") {
      if (
        !documentsHasMoreByLevel.templates.root ||
        loadingMoreDocumentsByLevel.templates.root
      )
        return;
      autoLoadTriggeredRef.current = true;
      void loadMoreLibraryDocuments("templates", null);
      return;
    }

    if (showTabs) {
      if (
        !documentsHasMoreByLevel.files.root ||
        loadingMoreDocumentsByLevel.files.root
      )
        return;
      autoLoadTriggeredRef.current = true;
      void loadMoreLibraryDocuments("files", null);
      return;
    }

    if (
      !rootDocumentsHasMore ||
      loadingMoreRootDocuments ||
      !onLoadMoreRootDocuments
    )
      return;
    autoLoadTriggeredRef.current = true;
    void onLoadMoreRootDocuments();
  }

    function toggle(doc: Document) {
        if (disabledDocumentIds?.has(doc.id)) return;

        const next = new Map(
            selectedDocuments.map((document) => [document.id, document]),
        );
        if (next.has(doc.id)) {
            next.delete(doc.id);
        } else {
            next.set(doc.id, doc);
        }
        onChange([...next.values()]);
    }

    function toggleFolder(projectId: string) {
    const opening = !expandedProjects.has(projectId);
        setExpandedProjects((prev) => {
            const next = new Set(prev);
            if (next.has(projectId)) {
                next.delete(projectId);
            } else {
                next.add(projectId);
            }
            return next;
        });
    if (opening) void loadProjectLevel(projectId, null);
    }

    function toggleDocuments(docs: Document[]) {
        const selectableDocs = docs.filter(
            (doc) => !disabledDocumentIds?.has(doc.id),
        );
        if (selectableDocs.length === 0) return;

        const allSelected = selectableDocs.every((doc) =>
            selectedIds.has(doc.id),
        );
        const next = new Map(
            selectedDocuments.map((document) => [document.id, document]),
        );
        if (allSelected) {
            selectableDocs.forEach((doc) => next.delete(doc.id));
        } else {
            selectableDocs.forEach((doc) => next.set(doc.id, doc));
        }
        onChange([...next.values()]);
    }

    function documentFolderId(doc: Document) {
        return doc.folder_id ?? doc.library_folder_id ?? null;
    }

    function childFolders(
        folders: DirectoryFolder[],
        parentFolderId: string | null,
    ) {
        return folders.filter(
            (folder) => (folder.parent_folder_id ?? null) === parentFolderId,
        );
    }

    function folderDocuments(docs: Document[], folderId: string | null) {
        return docs.filter((doc) => documentFolderId(doc) === folderId);
    }

    function collectFolderDocuments(
        folders: DirectoryFolder[],
        docs: Document[],
        folderId: string,
    ): Document[] {
        const directDocs = folderDocuments(docs, folderId);
        const nestedDocs = childFolders(folders, folderId).flatMap((folder) =>
            collectFolderDocuments(folders, docs, folder.id),
        );
        return [...directDocs, ...nestedDocs];
    }

  function folderIsFullyLoaded(
    allFolders: DirectoryFolder[],
    folderId: string,
    libraryTab?: "files" | "templates",
    projectId?: string,
  ): boolean {
    const levelLoaded = libraryTab
      ? loadedFolderIds[libraryTab].has(folderId)
      : projectId
        ? loadedProjectLevels.has(`${projectId}:${folderId}`)
        : externalLoadedFolderIds.has(folderId);
    const levelHasMore = libraryTab
      ? !!documentsHasMoreByLevel[libraryTab][folderId]
      : projectId
        ? !!projectDocumentsHasMoreByLevel[`${projectId}:${folderId}`]
        : !!documentsHasMoreByFolder[folderId];
    return (
      levelLoaded &&
      !levelHasMore &&
      childFolders(allFolders, folderId).every((child) =>
        folderIsFullyLoaded(allFolders, child.id, libraryTab, projectId),
      )
    );
  }

  function toggleLibraryFolder(
    folderId: string,
    libraryTab?: "files" | "templates",
    projectId?: string,
  ) {
    const opening = !expandedLibraryFolders.has(folderId);
        setExpandedLibraryFolders((prev) => {
            const next = new Set(prev);
            if (next.has(folderId)) {
                next.delete(folderId);
            } else {
                next.add(folderId);
            }
            return next;
        });
    if (opening && libraryTab && !loadedFolderIds[libraryTab].has(folderId)) {
      void loadFolderChildren(libraryTab, folderId);
    } else if (
      opening &&
      projectId &&
      !loadedProjectLevels.has(`${projectId}:${folderId}`)
    ) {
      void loadProjectLevel(projectId, folderId);
    } else if (opening && !libraryTab && !projectId && onExpandFolder) {
      void onExpandFolder(folderId);
    }
    }

    function handleTabChange(tab: DirectoryTab) {
        setSelectedTab(tab);
        void loadTab(tab);
    }

    function indentedRowPadding(depth: number) {
        return 8 + Math.max(0, depth) * 22;
    }

    function renderDocumentRow(doc: Document, depth = 0) {
        const selected = checkedIds.has(doc.id);
        const disabled = disabledDocumentIds?.has(doc.id) ?? false;
        return (
            <label
                key={doc.id}
                style={{ paddingLeft: indentedRowPadding(depth) }}
                className={`w-full rounded-md ${DIRECTORY_GRID_CLASS} py-2 pr-2 text-left text-xs transition-all ${
                    disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                } ${
          selected
            ? LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS
            : LIQUID_GLASS_MODAL_ROW_HOVER_CLASS
                }`}
            >
                <DirectorySelectionCheckbox
                    checked={selected}
                    indeterminate={false}
                    disabled={disabled}
                    label={`Select ${doc.filename}`}
                    onChange={() => toggle(doc)}
                />
                <DocFileIcon fileType={doc.file_type} />
                <span
          className={`min-w-0 truncate ${selected ? "text-gray-900" : "text-gray-700"}`}
                >
                    {doc.filename}
                </span>
                <FileDirectoryMetaCells
                    version={versionLabel(doc)}
                    created={formatDate(doc.created_at)}
                    size={formatBytes(doc.size_bytes)}
                />
            </label>
        );
    }

    function renderFolderRows(
        folders: DirectoryFolder[],
        docs: Document[],
        parentFolderId: string | null,
        depth = 0,
    libraryTab?: "files" | "templates",
    projectId?: string,
    ): ReactNode {
        return childFolders(folders, parentFolderId).map((folder) => {
            const docsInFolder = collectFolderDocuments(folders, docs, folder.id);
      const directDocs = folderDocuments(docs, folder.id);
      const visibleDirectDocs =
        !q && documentLimitByLevel[folder.id] != null
          ? directDocs.slice(0, documentLimitByLevel[folder.id])
          : directDocs;
      const folderSelectionReady = folderIsFullyLoaded(
        folders,
        folder.id,
        libraryTab,
        projectId,
      );
            const allSelected =
                docsInFolder.length > 0 &&
                docsInFolder.every((doc) => checkedIds.has(doc.id));
            const someSelected =
        docsInFolder.some((doc) => checkedIds.has(doc.id)) && !allSelected;
            const isExpanded = !!q || expandedLibraryFolders.has(folder.id);
            return (
                <div key={folder.id}>
                    <div
                        style={{ paddingLeft: indentedRowPadding(depth) }}
                        className={`w-full rounded-md ${DIRECTORY_GRID_CLASS} py-2 pr-2 text-xs transition-all ${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS}`}
                    >
                        <DirectorySelectionCheckbox
                            checked={allSelected}
                            indeterminate={someSelected}
                            disabled={
                                !folderSelectionReady ||
                                docsInFolder.length === 0
                            }
                            label={
                                folderSelectionReady
                                    ? `Select all files in ${folder.name}`
                                    : `Expand ${folder.name} and load all files before selecting it`
                            }
                            onChange={() => toggleDocuments(docsInFolder)}
                        />
                        <button
                            type="button"
                            aria-expanded={isExpanded}
                            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${folder.name}`}
                            onClick={() =>
                                toggleLibraryFolder(
                                    folder.id,
                                    libraryTab,
                                    projectId,
                                )
                            }
                            className={DIRECTORY_ROW_ACTION_CLASS}
                        >
            {(libraryTab && loadingFolderIds[libraryTab].has(folder.id)) ||
            (projectId &&
              loadingProjectLevels.has(`${projectId}:${folder.id}`)) ||
            externalLoadingFolderIds.has(folder.id) ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-400" />
            ) : (
                        <SubfolderSvgIcon
                            open={isExpanded}
                            className="h-3.5 w-3.5 shrink-0"
                        />
            )}
                        <span className="min-w-0 truncate font-medium text-gray-700">
                            {folder.name}
                        </span>
                        <span className="truncate text-gray-400">-</span>
                        <span className="truncate text-gray-400">
                            {formatDate(folder.created_at) ?? "--"}
                        </span>
                        <span className="truncate text-right text-gray-400">
                            {docsInFolder.length}{" "}
                            {docsInFolder.length === 1 ? "file" : "files"}
                        </span>
                        </button>
                    </div>
                    {isExpanded && (
                        <div>
                            {renderFolderRows(
                                folders,
                                docs,
                                folder.id,
                                depth + 1,
                libraryTab,
                projectId,
                            )}
                            {visibleDirectDocs.map((doc) =>
                                renderDocumentRow(doc, depth + 1),
                            )}
              {libraryTab && !q && (
                <div
                  style={{
                    paddingLeft: indentedRowPadding(depth + 1),
                  }}
                >
                  <TableLoadMoreRow
                    autoLoadOnVisible
                    loading={loadingFolderIds[libraryTab].has(folder.id)}
                    hasMore={!!documentsHasMoreByLevel[libraryTab][folder.id]}
                    itemCount={visibleDirectDocs.length}
                    loadingMore={
                      !!loadingMoreDocumentsByLevel[libraryTab][folder.id]
                    }
                    hasError={false}
                    onLoadMore={() =>
                      void loadMoreLibraryDocuments(libraryTab, folder.id)
                    }
                  />
                </div>
              )}
              {projectId && !q && (
                <div
                  style={{
                    paddingLeft: indentedRowPadding(depth + 1),
                  }}
                >
                  <TableLoadMoreRow
                    autoLoadOnVisible
                    loading={loadingProjectLevels.has(
                      `${projectId}:${folder.id}`,
                    )}
                    hasMore={
                      !!projectDocumentsHasMoreByLevel[
                        `${projectId}:${folder.id}`
                      ]
                    }
                    itemCount={visibleDirectDocs.length}
                    loadingMore={loadingProjectLevels.has(
                      `more:${projectId}:${folder.id}`,
                    )}
                    hasError={false}
                    onLoadMore={() =>
                      void loadMoreProjectDocuments(projectId, folder.id)
                    }
                  />
                </div>
              )}
              {!libraryTab && !projectId && onLoadMoreFolderDocuments && !q && (
                <div
                  style={{
                    paddingLeft: indentedRowPadding(depth + 1),
                  }}
                >
                  <TableLoadMoreRow
                    autoLoadOnVisible
                    loading={externalLoadingFolderIds.has(folder.id)}
                    hasMore={!!documentsHasMoreByFolder[folder.id]}
                    itemCount={visibleDirectDocs.length}
                    loadingMore={externalLoadingMoreFolderIds.has(folder.id)}
                    hasError={false}
                    onLoadMore={() => void onLoadMoreFolderDocuments(folder.id)}
                  />
                </div>
              )}
              {folderDocuments(docs, folder.id).length === 0 &&
                childFolders(folders, folder.id).length === 0 &&
                (!libraryTab || loadedFolderIds[libraryTab].has(folder.id)) && (
                                <p
                                    className="py-1 text-xs text-gray-400"
                                    style={{
                      paddingLeft: indentedRowPadding(depth + 1),
                                    }}
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

    if (activeLoading) {
        return (
            <div className="flex min-h-0 flex-1 flex-col space-y-2">
                <SearchBar
                    value={search}
                    onValueChange={setSearch}
                    placeholder="Search..."
                    autoFocus
                    wrapperClassName={showTabs ? "mb-4" : "mb-3"}
                />
                {(showTabs || selectedIds.size > 0) && (
                    <FileDirectoryControls
                        activeTab={activeTab}
                        onChange={handleTabChange}
                        selectedCount={selectedIds.size}
                        showTabs={showTabs}
                        tabs={availableTabs}
                    />
                )}
                <div className="flex min-h-0 flex-1 flex-col">
                    <FileDirectoryHeader />
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {[60, 45, 75, 55, 40].map((w, i) => (
                            <div
                                key={i}
                                className={`${DIRECTORY_GRID_CLASS} rounded-md px-2 py-2`}
                            >
                                <Loader2 className="h-2.5 w-2.5 shrink-0 justify-self-center animate-spin text-gray-400" />
                                <FileTypeIcon
                                    fileType={null}
                                    muted
                                    className="h-3.5 w-3.5"
                                />
                                <div
                                    className="h-3 rounded bg-gray-100 animate-pulse"
                                    style={{ width: `${w}%` }}
                                />
                                <SkeletonLine className="w-8" />
                                <SkeletonLine className="w-14" />
                                <SkeletonLine className="ml-auto w-10" />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    if (
        !showTabs &&
        directoryStandaloneDocs.length === 0 &&
        uploadingFilenames.length === 0
    ) {
        return (
            <div className="flex min-h-0 flex-1 flex-col space-y-2">
                <SearchBar
                    value={search}
                    onValueChange={setSearch}
                    placeholder="Search..."
                    autoFocus
                    wrapperClassName={showTabs ? "mb-4" : "mb-3"}
                />
                {(showTabs || selectedIds.size > 0) && (
                    <FileDirectoryControls
                        activeTab={activeTab}
                        onChange={handleTabChange}
                        selectedCount={selectedIds.size}
                        showTabs={showTabs}
                        tabs={availableTabs}
                    />
                )}
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <p className="text-center text-sm text-gray-400 py-8">
                        No documents yet
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col space-y-2 rounded-sm">
            <SearchBar
                value={search}
                onValueChange={setSearch}
                placeholder="Search..."
                autoFocus
                wrapperClassName={showTabs ? "mb-4" : "mb-3"}
            />
            {(showTabs || selectedIds.size > 0) && (
                <FileDirectoryControls
                    activeTab={activeTab}
                    onChange={handleTabChange}
                    selectedCount={selectedIds.size}
                    showTabs={showTabs}
                    tabs={availableTabs}
                />
            )}
            {activeTabHasNoResults ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <p className="text-center text-sm text-gray-400 py-8">
                        No matches found
                    </p>
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                    <FileDirectoryHeader />
                    <div
                      aria-label="File directory"
                      className="min-h-0 flex-1 overflow-y-auto"
                      onScroll={handleDirectoryScroll}
                    >
                    {activeTab === "files" && (
                        <>
                            {visibleUploadingFilenames.map((filename) => (
                                <div
                                    key={`uploading-${filename}`}
                                    className={`w-full ${DIRECTORY_GRID_CLASS} py-2 pl-2 pr-2 text-xs text-left`}
                                >
                                    <Loader2 className="h-2.5 w-2.5 shrink-0 justify-self-center animate-spin text-gray-400" />
                                    <FileTypeIcon
                                        fileType={filename}
                                        muted
                                        className="h-3.5 w-3.5"
                                    />
                                    <span className="flex-1 truncate text-gray-400">
                                        {filename}
                                    </span>
                                    <FileDirectoryMetaCells
                                        version={null}
                                        created="Uploading"
                                        size={null}
                                    />
                                </div>
                            ))}
                            {!q &&
                                renderFolderRows(
                                    directoryFileFolders,
                                    directoryStandaloneDocs,
                                    null,
                    0,
                    showTabs ? "files" : undefined,
                                )}
                            {(q
                                ? visibleStandaloneDocs
                                : documentLimitByLevel.root != null
                                  ? folderDocuments(
                                      directoryStandaloneDocs,
                                      null,
                                    ).slice(0, documentLimitByLevel.root)
                                  : folderDocuments(
                                      directoryStandaloneDocs,
                                      null,
                                    )
                            ).map((doc) => renderDocumentRow(doc))}
                {!q && (
                  <TableLoadMoreRow
                    loading={false}
                    hasMore={
                      showTabs
                        ? !!documentsHasMoreByLevel.files.root
                        : rootDocumentsHasMore
                    }
                    itemCount={
                      documentLimitByLevel.root != null
                        ? Math.min(
                            folderDocuments(directoryStandaloneDocs, null)
                              .length,
                            documentLimitByLevel.root,
                          )
                        : folderDocuments(directoryStandaloneDocs, null).length
                    }
                    loadingMore={
                      showTabs
                        ? !!loadingMoreDocumentsByLevel.files.root
                        : loadingMoreRootDocuments
                    }
                    hasError={false}
                    onLoadMore={() => {
                      if (showTabs) {
                        void loadMoreLibraryDocuments("files", null);
                      } else {
                        void onLoadMoreRootDocuments?.();
                      }
                    }}
                  />
                )}
                {q && (
                  <TableLoadMoreRow
                    loading={false}
                    hasMore={searchHasMore}
                    itemCount={visibleStandaloneDocs.length}
                    loadingMore={searchLoading}
                    hasError={false}
                    onLoadMore={() => void loadMoreSearchResults()}
                  />
                )}
                            {!q &&
                                visibleStandaloneDocs.length === 0 &&
                                directoryFileFolders.length === 0 &&
                                visibleUploadingFilenames.length === 0 && (
                                    <p className="text-center text-sm text-gray-400 py-8">
                                        No documents yet
                                    </p>
                                )}
                        </>
                    )}

                    {activeTab === "templates" && (
                        <>
                            {!q &&
                                renderFolderRows(
                                    directoryTemplateFolders,
                                    directoryTemplateDocs,
                                    null,
                    0,
                    "templates",
                                )}
                            {(q
                                ? visibleTemplateDocs
                                : folderDocuments(directoryTemplateDocs, null)
                            ).map((doc) => renderDocumentRow(doc))}
                {!q && (
                  <TableLoadMoreRow
                    loading={false}
                    hasMore={!!documentsHasMoreByLevel.templates.root}
                    itemCount={
                      folderDocuments(directoryTemplateDocs, null).length
                    }
                    loadingMore={!!loadingMoreDocumentsByLevel.templates.root}
                    hasError={false}
                    onLoadMore={() =>
                      void loadMoreLibraryDocuments("templates", null)
                    }
                  />
                )}
                {q && (
                  <TableLoadMoreRow
                    loading={false}
                    hasMore={searchHasMore}
                    itemCount={visibleTemplateDocs.length}
                    loadingMore={searchLoading}
                    hasError={false}
                    onLoadMore={() => void loadMoreSearchResults()}
                  />
                )}
                            {!q &&
                                visibleTemplateDocs.length === 0 &&
                                directoryTemplateFolders.length === 0 && (
                                    <p className="text-center text-sm text-gray-400 py-8">
                                        No templates yet
                                    </p>
                                )}
                        </>
                    )}

                    {activeTab === "projects" &&
                        visibleDirectoryProjects.map((project) => {
                            const docs = project.documents ?? [];
                const isExpanded = q
                  ? docs.length > 0 || expandedProjects.has(project.id)
                  : expandedProjects.has(project.id);
                            const projectFolders = project.folders ?? [];
                const projectRootKey = `${project.id}:root`;
                const projectSelectionReady =
                  loadedProjectLevels.has(projectRootKey) &&
                  !projectDocumentsHasMoreByLevel[projectRootKey] &&
                  childFolders(projectFolders, null).every((folder) =>
                    folderIsFullyLoaded(
                      projectFolders,
                      folder.id,
                      undefined,
                      project.id,
                    ),
                  );
                            const projectDocIds = docs.map((doc) => doc.id);
                            const allProjectDocsSelected =
                                projectDocIds.length > 0 &&
                  projectDocIds.every((id) => checkedIds.has(id));
                            const someProjectDocsSelected =
                  projectDocIds.some((id) => checkedIds.has(id)) &&
                  !allProjectDocsSelected;
                            return (
                                <div key={project.id}>
                                    <div
                                        className={`w-full rounded-md ${DIRECTORY_GRID_CLASS} px-2 py-2 text-xs transition-all text-left ${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS}`}
                                    >
                                        <DirectorySelectionCheckbox
                                            checked={allProjectDocsSelected}
                                            indeterminate={
                                                someProjectDocsSelected
                                            }
                                            disabled={
                                                !projectSelectionReady ||
                                                docs.length === 0
                                            }
                                            label={
                                                projectSelectionReady
                                                    ? `Select all files in ${project.name}`
                                                    : `Expand ${project.name} and load all files before selecting it`
                                            }
                                            onChange={() =>
                                                toggleDocuments(docs)
                                            }
                                        />
                                        <button
                                            type="button"
                                            aria-expanded={isExpanded}
                                            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${project.name}`}
                                            onClick={() =>
                                                toggleFolder(project.id)
                                            }
                                            className={
                                                DIRECTORY_ROW_ACTION_CLASS
                                            }
                                        >
                                        <ProjectSvgIcon
                                            open={isExpanded}
                                            className="h-3.5 w-3.5 shrink-0"
                                        />
                                        <span className="min-w-0 truncate font-medium text-gray-700">
                                            {project.name}
                                            {project.cm_number && (
                                                <span className="ml-1 font-normal text-gray-400">
                                                    (#{project.cm_number})
                                                </span>
                                            )}
                                        </span>
                      <span className="truncate text-gray-400">-</span>
                                        <span className="truncate text-gray-400">
                        {formatDate(project.created_at) ?? "--"}
                                        </span>
                                        <span className="truncate text-right text-gray-400">
                        {docs.length} {docs.length === 1 ? "file" : "files"}
                                        </span>
                                        </button>
                                    </div>
                                    {isExpanded && (
                                        <div>
                        {loadingProjectLevels.has(`${project.id}:root`) ? (
                          <p className="flex items-center gap-2 pl-7 py-2 text-xs text-gray-400">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading project files
                          </p>
                        ) : docs.length === 0 && projectFolders.length === 0 ? (
                                                <p className="pl-7 py-1 text-xs text-gray-400">
                                                    Empty
                                                </p>
                                            ) : (
                                                <>
                                                    {!q &&
                                                        renderFolderRows(
                                                            projectFolders,
                                                            docs,
                                                            null,
                                                            1,
                                undefined,
                                project.id,
                                                        )}
                            {(q ? docs : folderDocuments(docs, null)).map(
                              (doc) => renderDocumentRow(doc, 1),
                            )}
                            {!q && (
                              <TableLoadMoreRow
                                autoLoadOnVisible
                                loading={false}
                                hasMore={
                                  !!projectDocumentsHasMoreByLevel[
                                    `${project.id}:root`
                                  ]
                                }
                                itemCount={folderDocuments(docs, null).length}
                                loadingMore={loadingProjectLevels.has(
                                  `more:${project.id}:root`,
                                )}
                                hasError={false}
                                onLoadMore={() =>
                                  void loadMoreProjectDocuments(
                                    project.id,
                                                              null,
                                                          )
                                }
                              />
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    {activeTab === "projects" &&
                        !q &&
                        visibleDirectoryProjects.length === 0 && (
                            <p className="text-center text-sm text-gray-400 py-8">
                                No projects yet
                            </p>
                        )}
            {activeTab === "projects" && !q && (
              <TableLoadMoreRow
                loading={false}
                hasMore={projectsHasMore}
                itemCount={visibleDirectoryProjects.length}
                loadingMore={loadingMoreProjects}
                hasError={false}
                onLoadMore={() => void loadMoreProjects()}
              />
            )}
            {activeTab === "projects" && !!q && (
              <TableLoadMoreRow
                loading={false}
                hasMore={searchHasMore}
                itemCount={visibleDirectoryProjects.length}
                loadingMore={searchLoading}
                hasError={false}
                onLoadMore={() => void loadMoreSearchResults()}
              />
            )}
                    </div>
                </div>
            )}
        </div>
    );
}

function FileDirectoryHeader() {
    return (
        <div
            className={`${DIRECTORY_GRID_CLASS} px-2 pb-1 pt-0.5 text-[11px] font-medium text-gray-400`}
        >
            <span className="col-span-3">Name</span>
            <span>Version</span>
            <span>Created</span>
            <span className="text-right">Size</span>
        </div>
    );
}

function FileDirectoryMetaCells({
    version,
    created,
    size,
}: {
    version: string | null;
    created: string | null;
    size: string | null;
}) {
    return (
        <>
            <span className="truncate text-gray-400">{version ?? "--"}</span>
            <span className="truncate text-gray-400">{created ?? "--"}</span>
      <span className="truncate text-right text-gray-400">{size ?? "--"}</span>
        </>
    );
}

function FileDirectoryControls({
    activeTab,
    onChange,
    selectedCount,
    showTabs,
    tabs,
}: {
    activeTab: DirectoryTab;
    onChange: (tab: DirectoryTab) => void;
    selectedCount: number;
    showTabs: boolean;
    tabs: typeof DIRECTORY_TABS;
}) {
    return (
        <div className="flex items-center justify-between gap-3 pr-2">
            {showTabs ? (
                <div className="flex items-center gap-1.5">
                    {tabs.map((tab) => {
                        const active = activeTab === tab.value;
                        return (
                            <TabPillButtonUI
                                key={tab.value}
                                active={active}
                                onClick={() => onChange(tab.value)}
                            >
                                {tab.label}
                            </TabPillButtonUI>
                        );
                    })}
                </div>
            ) : (
                <span />
            )}
            {selectedCount > 0 && (
                <span className="shrink-0 text-xs text-gray-400">
                    {selectedCount} selected
                </span>
            )}
        </div>
    );
}
