/**
 * Project-scoped roles and the capability matrix.
 *
 * Every access decision reduces to: derive the caller's ProjectRole for the
 * container (lib/access.ts), then ask `can(role, capability)` here. Routes
 * never compare roles or re-derive rights from an ownership flag — they
 * declare the capability they need, so the policy lives in exactly one table.
 *
 * The ladder (each tier includes everything below it):
 *
 *   role     | granted to
 *   ---------|------------------------------------------------------------
 *   viewer   | read-only access
 *   editor   | content collaboration and organization
 *   owner    | access management and container deletion. Creators are owners.
 *
 *   capability     | min role | covers
 *   ---------------|----------|----------------------------------------------
 *   project.view   | viewer   | read docs/chats/reviews, download, watch
 *                  |          | generation streams
 *   content.edit   | editor   | upload documents, push versions, chat,
 *                  |          | accept/reject edits, run extractions, reshape
 *                  |          | a review's columns/document set
 *   docs.organize  | editor   | rename/move documents AND create/rename/move/
 *                  |          | delete folders
 *   access.manage  | owner    | project settings, sharing and access grants
 *   container.delete | owner  | delete the project/review itself
 *
 * Editors can organize the same content they can modify. Owners additionally
 * control access and may delete the container.
 */

export type ProjectRole = "owner" | "editor" | "viewer";

/** The role values a direct access grant may carry (the whole ladder). */
export const PROJECT_ROLES: ProjectRole[] = ["owner", "editor", "viewer"];

export function isProjectRole(value: unknown): value is ProjectRole {
    return (
        typeof value === "string" &&
        (PROJECT_ROLES as string[]).includes(value)
    );
}

export type Capability =
    | "project.view"
    | "content.edit"
    | "docs.organize"
    | "access.manage"
    | "container.delete";

const ROLE_RANK: Record<ProjectRole, number> = {
    viewer: 0,
    editor: 1,
    owner: 2,
};

const REQUIRED_RANK: Record<Capability, number> = {
    "project.view": ROLE_RANK.viewer,
    "content.edit": ROLE_RANK.editor,
    "docs.organize": ROLE_RANK.editor,
    "access.manage": ROLE_RANK.owner,
    "container.delete": ROLE_RANK.owner,
};

/** Fail closed: an absent/unknown role can do nothing. */
export function can(
    role: ProjectRole | null | undefined,
    capability: Capability,
): boolean {
    if (!isProjectRole(role)) return false;
    return ROLE_RANK[role] >= REQUIRED_RANK[capability];
}

/**
 * A project the caller can open but not write to is not a missing project.
 * Collapsing "you cannot see this" and "your role is read-only" into one 404
 * told a Viewer their matter had vanished, so every write gate answers 404
 * only when checkProjectAccess itself refuses, and 403 with this intentional
 * message when the role is simply too low. Lives in lib/ because both the
 * projects and documents modules gate on it.
 */
export const DOCS_ORGANIZE_FORBIDDEN =
  "You do not have permission to organize documents in this project.";

/**
 * "Not found" is for rows the caller cannot see at all. A Viewer who can open
 * a document but not change it gets a refusal that names the reason, so the
 * UI stops telling people their document disappeared.
 */
export const DOCUMENT_EDIT_FORBIDDEN =
  "You do not have permission to edit content in this project.";
