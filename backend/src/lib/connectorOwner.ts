// Whose connections a request or a conversation uses.
//
// A person keeps a separate set of connectors (MCP servers, Google Drive,
// Gmail, Calendar, CourtListener) for Personal and for each team organization
// they belong to. Every connection is private to its person in every
// workspace; `orgId` only says which of their workspaces it serves: a team
// organization's id, or null for Personal. A connection for an organization
// is tied to the membership row and goes with it (20261022_01).

export type ConnectorOwner = {
    userId: string;
    /** A team organization's id, or null for Personal. */
    orgId: string | null;
};

export function personalConnectorOwner(userId: string): ConnectorOwner {
    return { userId, orgId: null };
}

/**
 * Arguments for a query's `.filter()` that narrow it to `owner`'s workspace:
 * `org_id=is.null` for Personal, `org_id=eq.<id>` for an organization. Pass
 * the embedded column (`user_mcp_connectors.org_id`) when filtering a join.
 * Pair it with a `user_id` filter; this says nothing about the person.
 */
export function workspaceFilter(
    owner: ConnectorOwner,
    column = "org_id",
): [string, "eq" | "is", string | null] {
    return owner.orgId ? [column, "eq", owner.orgId] : [column, "is", null];
}
