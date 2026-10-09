"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getProjectDirectoryLevel,
  getLibrary,
  getLibraryFolderChildren,
  listProjectSummaries,
  type LibraryKind,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import type { Document, LibraryFolder, Project } from "./types";

export type DirectoryTab = "files" | "templates" | "projects";

type LibraryDirectoryTab = Exclude<DirectoryTab, "projects">;

const DIRECTORY_PAGE_SIZE = 40;
const ROOT_LEVEL_KEY = "root";

const TAB_NOUN: Record<DirectoryTab, string> = {
  files: "files",
  templates: "templates",
  projects: "projects",
};

/**
 * Re-entry points for the toast "Retry" buttons. A `useCallback` cannot
 * reference itself, and these loaders are re-created whenever their state
 * changes, so the retry goes through the latest one by way of this ref
 * instead of capturing a stale closure.
 */
interface DirectoryRetries {
  loadTab: (tab: DirectoryTab) => void;
  loadFolderChildren: (tab: LibraryDirectoryTab, folderId: string) => void;
  loadMoreLibraryDocuments: (
    tab: LibraryDirectoryTab,
    parentId: string | null,
  ) => void;
  loadMoreProjects: () => void;
  loadProjectLevel: (
    projectId: string,
    parentFolderId: string | null,
  ) => void;
  loadMoreProjectDocuments: (
    projectId: string,
    parentFolderId: string | null,
  ) => void;
}

const NO_RETRIES: DirectoryRetries = {
  loadTab: () => {},
  loadFolderChildren: () => {},
  loadMoreLibraryDocuments: () => {},
  loadMoreProjects: () => {},
  loadProjectLevel: () => {},
  loadMoreProjectDocuments: () => {},
};

const EMPTY_LOADING: Record<DirectoryTab, boolean> = {
    files: false,
    templates: false,
    projects: false,
};

const EMPTY_LOADED: Record<DirectoryTab, boolean> = {
    files: false,
    templates: false,
    projects: false,
};

function sortDocuments(docs: Document[]) {
    return [...docs].sort((a, b) => {
        const aDate = a.updated_at ?? a.created_at ?? "";
        const bDate = b.updated_at ?? b.created_at ?? "";
        return bDate.localeCompare(aDate);
    });
}

function libraryKind(tab: LibraryDirectoryTab): LibraryKind {
  return tab === "files" ? "files" : "templates";
}

function documentFolderId(document: Document): string | null {
  return document.folder_id ?? document.library_folder_id ?? null;
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const next = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => next.set(item.id, item));
  return [...next.values()];
}

export function useDirectoryData(
    enabled: boolean,
    initialTab: DirectoryTab = "files",
) {
  const [standaloneDocuments, setStandaloneDocuments] = useState<Document[]>(
    [],
  );
    const [templateDocuments, setTemplateDocuments] = useState<Document[]>([]);
    const [fileFolders, setFileFolders] = useState<LibraryFolder[]>([]);
    const [templateFolders, setTemplateFolders] = useState<LibraryFolder[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
  const [projectsHasMore, setProjectsHasMore] = useState(false);
  const [loadingMoreProjects, setLoadingMoreProjects] = useState(false);
  const [loadedProjectLevels, setLoadedProjectLevels] = useState<Set<string>>(
    new Set(),
  );
  const [loadingProjectLevels, setLoadingProjectLevels] = useState<Set<string>>(
    new Set(),
  );
  const [projectDocumentsHasMoreByLevel, setProjectDocumentsHasMoreByLevel] =
    useState<Record<string, boolean>>({});
    const [loadingTabs, setLoadingTabs] =
        useState<Record<DirectoryTab, boolean>>(EMPTY_LOADING);
  const [loadedFolderIds, setLoadedFolderIds] = useState<
    Record<LibraryDirectoryTab, Set<string>>
  >({
    files: new Set(),
    templates: new Set(),
  });
  const [loadingFolderIds, setLoadingFolderIds] = useState<
    Record<LibraryDirectoryTab, Set<string>>
  >({
    files: new Set(),
    templates: new Set(),
  });
  const [documentsHasMoreByLevel, setDocumentsHasMoreByLevel] = useState<
    Record<LibraryDirectoryTab, Record<string, boolean>>
  >({ files: {}, templates: {} });
  const [loadingMoreDocumentsByLevel, setLoadingMoreDocumentsByLevel] =
    useState<Record<LibraryDirectoryTab, Record<string, boolean>>>({
      files: {},
      templates: {},
    });
    const loadingTabsRef = useRef<Record<DirectoryTab, boolean>>({
        ...EMPTY_LOADING,
    });
    const loadedTabsRef = useRef<Record<DirectoryTab, boolean>>({
        ...EMPTY_LOADED,
    });
  const loadedFolderIdsRef = useRef<Record<LibraryDirectoryTab, Set<string>>>({
    files: new Set(),
    templates: new Set(),
  });
  const folderRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const moreRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const standaloneDocumentsRef = useRef<Document[]>([]);
  const templateDocumentsRef = useRef<Document[]>([]);
  const projectsRef = useRef<Project[]>([]);
  const projectLevelRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const loadingMoreProjectsRef = useRef(false);
  const retryRef = useRef<DirectoryRetries>(NO_RETRIES);

  useEffect(() => {
    standaloneDocumentsRef.current = standaloneDocuments;
  }, [standaloneDocuments]);

  useEffect(() => {
    templateDocumentsRef.current = templateDocuments;
  }, [templateDocuments]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const setLibraryDocuments = useCallback(
    (tab: LibraryDirectoryTab, update: (current: Document[]) => Document[]) => {
      if (tab === "files") setStandaloneDocuments(update);
      else setTemplateDocuments(update);
    },
    [],
  );

  const setLibraryFolders = useCallback(
    (
      tab: LibraryDirectoryTab,
      update: (current: LibraryFolder[]) => LibraryFolder[],
    ) => {
      if (tab === "files") setFileFolders(update);
      else setTemplateFolders(update);
    },
    [],
  );

    const loadTab = useCallback(
        async (tab: DirectoryTab) => {
            if (
                !enabled ||
                loadingTabsRef.current[tab] ||
                loadedTabsRef.current[tab]
            ) {
                return;
            }

            loadingTabsRef.current = {
                ...loadingTabsRef.current,
                [tab]: true,
            };
            setLoadingTabs((prev) => ({ ...prev, [tab]: true }));
            try {
        if (tab === "projects") {
          const rows = await listProjectSummaries({
            limit: DIRECTORY_PAGE_SIZE + 1,
          });
          setProjects(
            rows.slice(0, DIRECTORY_PAGE_SIZE).map((project) => ({
              ...project,
              documents: [],
              folders: [],
            })),
          );
          setProjectsHasMore(rows.length > DIRECTORY_PAGE_SIZE);
                } else {
          const result = await getLibrary(libraryKind(tab), {
            limit: DIRECTORY_PAGE_SIZE,
          });
          setLibraryDocuments(tab, () => sortDocuments(result.documents));
          setLibraryFolders(tab, () => result.folders);
          setDocumentsHasMoreByLevel((prev) => ({
            ...prev,
            [tab]: {
              ...prev[tab],
              [ROOT_LEVEL_KEY]: result.documentsHasMore,
            },
          }));
                }
                loadedTabsRef.current = {
                    ...loadedTabsRef.current,
                    [tab]: true,
                };
            } catch (error) {
                if (tab === "files") {
                    setStandaloneDocuments([]);
                    setFileFolders([]);
                } else if (tab === "templates") {
                    setTemplateDocuments([]);
                    setTemplateFolders([]);
                } else {
                    setProjects([]);
                }
                // The picker is now empty for a reason the user cannot see,
                // so say so instead of passing an empty shelf off as the
                // truth.
                notifyError(error, {
                    action: `load your ${TAB_NOUN[tab]}`,
                    dedupeKey: `directory:${tab}`,
                    onRetry: () => retryRef.current.loadTab(tab),
                });
            } finally {
                loadingTabsRef.current = {
                    ...loadingTabsRef.current,
                    [tab]: false,
                };
                setLoadingTabs((prev) => ({ ...prev, [tab]: false }));
            }
        },
    [enabled, setLibraryDocuments, setLibraryFolders],
  );

  const loadFolderChildren = useCallback(
    async (tab: LibraryDirectoryTab, folderId: string) => {
      if (!enabled || loadedFolderIdsRef.current[tab].has(folderId)) return;
      const requestKey = `${tab}:${folderId}`;
      const existing = folderRequestsRef.current.get(requestKey);
      if (existing) return existing;

      setLoadingFolderIds((prev) => ({
        ...prev,
        [tab]: new Set(prev[tab]).add(folderId),
      }));
      const request = (async () => {
        try {
          const result = await getLibraryFolderChildren(
            libraryKind(tab),
            folderId,
            {
              limit: DIRECTORY_PAGE_SIZE,
            },
          );
          setLibraryDocuments(tab, (current) =>
            sortDocuments(mergeById(current, result.documents)),
          );
          setLibraryFolders(tab, (current) =>
            mergeById(current, result.folders),
          );
          const nextLoaded = new Set(loadedFolderIdsRef.current[tab]).add(
            folderId,
          );
          loadedFolderIdsRef.current = {
            ...loadedFolderIdsRef.current,
            [tab]: nextLoaded,
          };
          setLoadedFolderIds((prev) => ({
            ...prev,
            [tab]: nextLoaded,
          }));
          setDocumentsHasMoreByLevel((prev) => ({
            ...prev,
            [tab]: {
              ...prev[tab],
              [folderId]: result.documentsHasMore,
            },
          }));
        } catch (error) {
          // A folder that stays empty after the spinner looks like an empty
          // folder, so the failure has to be said out loud.
          notifyError(error, {
            action: "open the folder",
            dedupeKey: `directory-folder:${tab}:${folderId}`,
            onRetry: () =>
              retryRef.current.loadFolderChildren(tab, folderId),
          });
        } finally {
          setLoadingFolderIds((prev) => {
            const next = new Set(prev[tab]);
            next.delete(folderId);
            return { ...prev, [tab]: next };
          });
          folderRequestsRef.current.delete(requestKey);
        }
      })();
      folderRequestsRef.current.set(requestKey, request);
      return request;
    },
    [enabled, setLibraryDocuments, setLibraryFolders],
  );

  const loadMoreLibraryDocuments = useCallback(
    async (tab: LibraryDirectoryTab, parentId: string | null) => {
      if (!enabled) return;
      const levelKey = parentId ?? ROOT_LEVEL_KEY;
      const requestKey = `${tab}:${levelKey}`;
      const existing = moreRequestsRef.current.get(requestKey);
      if (existing) return existing;

      const currentDocuments =
        tab === "files"
          ? standaloneDocumentsRef.current
          : templateDocumentsRef.current;
      const offset = currentDocuments.filter(
        (document) => documentFolderId(document) === parentId,
      ).length;
      setLoadingMoreDocumentsByLevel((prev) => ({
        ...prev,
        [tab]: { ...prev[tab], [levelKey]: true },
      }));

      const request = (async () => {
        try {
          const result = parentId
            ? await getLibraryFolderChildren(libraryKind(tab), parentId, {
                limit: DIRECTORY_PAGE_SIZE,
                offset,
              })
            : await getLibrary(libraryKind(tab), {
                limit: DIRECTORY_PAGE_SIZE,
                offset,
              });
          setLibraryDocuments(tab, (current) =>
            sortDocuments(mergeById(current, result.documents)),
          );
          setLibraryFolders(tab, (current) =>
            mergeById(current, result.folders),
          );
          setDocumentsHasMoreByLevel((prev) => ({
            ...prev,
            [tab]: {
              ...prev[tab],
              [levelKey]: result.documentsHasMore,
            },
          }));
        } catch (error) {
          notifyError(error, {
            action: `load more ${TAB_NOUN[tab]}`,
            dedupeKey: `directory-more:${tab}:${levelKey}`,
            onRetry: () =>
              retryRef.current.loadMoreLibraryDocuments(tab, parentId),
          });
        } finally {
          setLoadingMoreDocumentsByLevel((prev) => ({
            ...prev,
            [tab]: { ...prev[tab], [levelKey]: false },
          }));
          moreRequestsRef.current.delete(requestKey);
        }
      })();
      moreRequestsRef.current.set(requestKey, request);
      return request;
    },
    [enabled, setLibraryDocuments, setLibraryFolders],
  );

  const loadMoreProjects = useCallback(async () => {
    if (!enabled || !projectsHasMore || loadingMoreProjectsRef.current) {
      return;
    }
    loadingMoreProjectsRef.current = true;
    setLoadingMoreProjects(true);
    try {
      const rows = await listProjectSummaries({
        limit: DIRECTORY_PAGE_SIZE + 1,
        offset: projectsRef.current.length,
      });
      setProjects((current) =>
        mergeById(
          current,
          rows.slice(0, DIRECTORY_PAGE_SIZE).map((project) => ({
            ...project,
            documents: [],
            folders: [],
          })),
        ),
      );
      setProjectsHasMore(rows.length > DIRECTORY_PAGE_SIZE);
    } catch (error) {
      notifyError(error, {
        action: "load more projects",
        dedupeKey: "directory-more-projects",
        onRetry: () => retryRef.current.loadMoreProjects(),
      });
    } finally {
      loadingMoreProjectsRef.current = false;
      setLoadingMoreProjects(false);
    }
  }, [enabled, projectsHasMore]);

  const loadProjectLevel = useCallback(
    async (projectId: string, parentFolderId: string | null = null) => {
      if (!enabled) return;
      const levelKey = `${projectId}:${parentFolderId ?? ROOT_LEVEL_KEY}`;
      if (loadedProjectLevels.has(levelKey)) return;
      const existing = projectLevelRequestsRef.current.get(levelKey);
      if (existing) return existing;

      setLoadingProjectLevels((current) => new Set(current).add(levelKey));
      const request = (async () => {
        try {
          const result = await getProjectDirectoryLevel(projectId, {
            parentFolderId,
            limit: DIRECTORY_PAGE_SIZE,
          });
          setProjects((current) =>
            current.map((project) =>
              project.id === projectId
                ? {
                    ...project,
                    documents: sortDocuments(
                      mergeById(project.documents ?? [], result.documents),
                    ),
                    folders: mergeById(project.folders ?? [], result.folders),
                  }
                : project,
            ),
          );
          setLoadedProjectLevels((current) => new Set(current).add(levelKey));
          setProjectDocumentsHasMoreByLevel((current) => ({
            ...current,
            [levelKey]: result.documentsHasMore,
          }));
        } catch (error) {
          notifyError(error, {
            action: "open the project folder",
            dedupeKey: `directory-project-level:${levelKey}`,
            onRetry: () =>
              retryRef.current.loadProjectLevel(projectId, parentFolderId),
          });
        } finally {
          setLoadingProjectLevels((current) => {
            const next = new Set(current);
            next.delete(levelKey);
            return next;
          });
          projectLevelRequestsRef.current.delete(levelKey);
        }
      })();
      projectLevelRequestsRef.current.set(levelKey, request);
      return request;
    },
    [enabled, loadedProjectLevels],
  );

  const loadMoreProjectDocuments = useCallback(
    async (projectId: string, parentFolderId: string | null = null) => {
      if (!enabled) return;
      const levelKey = `${projectId}:${parentFolderId ?? ROOT_LEVEL_KEY}`;
      const requestKey = `more:${levelKey}`;
      const existing = projectLevelRequestsRef.current.get(requestKey);
      if (existing) return existing;
      const project = projectsRef.current.find(
        (candidate) => candidate.id === projectId,
      );
      const offset = (project?.documents ?? []).filter(
        (document) => documentFolderId(document) === parentFolderId,
      ).length;
      setLoadingProjectLevels((current) => new Set(current).add(requestKey));
      const request = (async () => {
        try {
          const result = await getProjectDirectoryLevel(projectId, {
            parentFolderId,
            limit: DIRECTORY_PAGE_SIZE,
            offset,
          });
          setProjects((current) =>
            current.map((candidate) =>
              candidate.id === projectId
                ? {
                    ...candidate,
                    documents: sortDocuments(
                      mergeById(candidate.documents ?? [], result.documents),
                    ),
                    folders: mergeById(candidate.folders ?? [], result.folders),
                  }
                : candidate,
            ),
          );
          setProjectDocumentsHasMoreByLevel((current) => ({
            ...current,
            [levelKey]: result.documentsHasMore,
          }));
        } catch (error) {
          notifyError(error, {
            action: "load more project files",
            dedupeKey: `directory-project-more:${levelKey}`,
            onRetry: () =>
              retryRef.current.loadMoreProjectDocuments(
                projectId,
                parentFolderId,
              ),
          });
        } finally {
          setLoadingProjectLevels((current) => {
            const next = new Set(current);
            next.delete(requestKey);
            return next;
          });
          projectLevelRequestsRef.current.delete(requestKey);
        }
      })();
      projectLevelRequestsRef.current.set(requestKey, request);
      return request;
    },
        [enabled],
    );

    useEffect(() => {
        retryRef.current = {
            loadTab: (tab) => void loadTab(tab),
            loadFolderChildren: (tab, folderId) =>
                void loadFolderChildren(tab, folderId),
            loadMoreLibraryDocuments: (tab, parentId) =>
                void loadMoreLibraryDocuments(tab, parentId),
            loadMoreProjects: () => void loadMoreProjects(),
            loadProjectLevel: (projectId, parentFolderId) =>
                void loadProjectLevel(projectId, parentFolderId),
            loadMoreProjectDocuments: (projectId, parentFolderId) =>
                void loadMoreProjectDocuments(projectId, parentFolderId),
        };
    }, [
        loadFolderChildren,
        loadMoreLibraryDocuments,
        loadMoreProjectDocuments,
        loadMoreProjects,
        loadProjectLevel,
        loadTab,
    ]);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            void loadTab(initialTab);
        });

        return () => {
            cancelled = true;
        };
    }, [enabled, initialTab, loadTab]);

    return {
        loading: loadingTabs[initialTab],
        loadingTabs,
        standaloneDocuments,
        templateDocuments,
        fileFolders,
        templateFolders,
        projects,
    projectsHasMore,
    loadingMoreProjects,
    loadedProjectLevels,
    loadingProjectLevels,
    projectDocumentsHasMoreByLevel,
    loadedFolderIds,
    loadingFolderIds,
    documentsHasMoreByLevel,
    loadingMoreDocumentsByLevel,
        loadTab,
    loadFolderChildren,
    loadMoreLibraryDocuments,
    loadMoreProjects,
    loadProjectLevel,
    loadMoreProjectDocuments,
    };
}
