import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { PERSONAL_WORKSPACE } from "@mike/client";
import { useWorkspaceSelection } from "@mike/ui";
import { listOrgs, type Org } from "../api/mikeApi";
import { notifyInfo } from "./notify";
import {
  onWorkspaceGone,
  paneWorkspaceStorage,
  workspaceGoneMessage,
} from "./workspaceState";

export interface AddinWorkspace {
  /** "personal" or an organization id: the workspace the pane works in. */
  workspaceId: string;
  /** Whether the remembered choice has been read from pane storage. */
  ready: boolean;
  /** The caller's team organizations; `null` until first loaded. */
  organizations: Org[] | null;
  /** The active organization, or `null` in Personal. */
  activeOrganization: Org | null;
  setWorkspace: (workspaceId: string) => void;
  refreshOrganizations: () => Promise<void>;
}

const PERSONAL: AddinWorkspace = {
  workspaceId: PERSONAL_WORKSPACE,
  ready: true,
  organizations: null,
  activeOrganization: null,
  setWorkspace: () => {},
  refreshOrganizations: async () => {},
};

const AddinWorkspaceContext = createContext<AddinWorkspace>(PERSONAL);

/**
 * The pane's active workspace: Personal or one of the caller's team
 * organizations, as in the web app's sidebar. The rules (remembering,
 * falling back, switching) are the web app's `useWorkspaceSelection`; this
 * supplies the pane's storage and its organizations request. The choice is a
 * filter on what the caller can already open; the server re-checks
 * membership on every request.
 */
export function AddinWorkspaceProvider({
  userId,
  children,
}: {
  userId: string | undefined;
  children: ReactNode;
}): React.ReactElement {
  const selection = useWorkspaceSelection<Org>({
    userId,
    listOrgs,
    storage: paneWorkspaceStorage,
  });
  const { refreshOrganizations } = selection;

  // Named in the notice after the fallback, when the list no longer has it.
  const activeNameRef = useRef<string | null>(null);
  if (selection.activeOrganization) {
    activeNameRef.current = selection.activeOrganization.name;
  }
  const workspaceRef = useRef(selection.workspaceId);
  workspaceRef.current = selection.workspaceId;
  // Set while a refusal's re-read is out: the organization to name once the
  // pane has actually fallen back to Personal.
  const goneNoticeRef = useRef<{ name: string | null } | null>(null);

  // A list answered 404 workspace_not_found: the caller has left the
  // organization the pane is in. Reading their organizations again is what
  // moves the pane back to Personal.
  useEffect(
    () =>
      onWorkspaceGone(() => {
        if (workspaceRef.current === PERSONAL_WORKSPACE) return;
        goneNoticeRef.current = { name: activeNameRef.current };
        void refreshOrganizations();
      }),
    [refreshOrganizations],
  );

  useEffect(() => {
    if (!goneNoticeRef.current || selection.workspaceId !== PERSONAL_WORKSPACE) {
      return;
    }
    notifyInfo(workspaceGoneMessage(goneNoticeRef.current.name));
    goneNoticeRef.current = null;
  }, [selection.workspaceId]);

  const { setWorkspace: selectWorkspace } = selection;
  const setWorkspace = useCallback(
    (workspaceId: string) => {
      // A choice the person makes is not the fallback the notice is about.
      goneNoticeRef.current = null;
      selectWorkspace(workspaceId);
    },
    [selectWorkspace],
  );

  const value = useMemo<AddinWorkspace>(
    () => ({
      workspaceId: selection.workspaceId,
      ready: selection.ready,
      organizations: selection.organizations,
      activeOrganization: selection.activeOrganization,
      setWorkspace,
      refreshOrganizations: selection.refreshOrganizations,
    }),
    [
      selection.workspaceId,
      selection.ready,
      selection.organizations,
      selection.activeOrganization,
      setWorkspace,
      selection.refreshOrganizations,
    ],
  );

  return (
    <AddinWorkspaceContext.Provider value={value}>
      {children}
    </AddinWorkspaceContext.Provider>
  );
}

/** The pane's workspace; Personal outside an `AddinWorkspaceProvider`. */
export function useAddinWorkspace(): AddinWorkspace {
  return useContext(AddinWorkspaceContext);
}
