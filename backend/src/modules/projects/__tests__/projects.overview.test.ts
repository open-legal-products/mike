import { describe, expect, it } from "vitest";
import {
    buildProjectIdsOverviewRpcArgs,
    buildProjectsOverviewRpcArgs,
    parseProjectScope,
} from "../projects.overview";

describe("buildProjectsOverviewRpcArgs", () => {
    it("builds the full RPC payload when the paginated signature is requested", () => {
        expect(
            buildProjectsOverviewRpcArgs({
                userId: "user-1",
                userEmail: " User@Example.com ",
                scope: "mine",
                pagination: { limit: 25, offset: 10 },
                searchTerm: "merger",
                sort: { key: "name", direction: "asc" },
                practice: "Litigation",
                ownerUserId: "user-2",
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: "user@example.com",
            p_scope: "mine",
            p_limit: 25,
            p_offset: 10,
            p_search_term: "merger",
            p_sort_key: "name",
            p_sort_direction: "asc",
            p_practice: "Litigation",
            p_owner_user_id: "user-2",
        });
    });

    it("uses default pagination, sort, and filter values when omitted", () => {
        expect(
            buildProjectsOverviewRpcArgs({
                userId: "user-1",
                userEmail: undefined,
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: null,
            p_scope: "all",
            p_limit: 20,
            p_offset: 0,
            p_search_term: null,
            p_sort_key: "created",
            p_sort_direction: "desc",
            p_practice: null,
            p_owner_user_id: null,
        });
    });
});

describe("buildProjectIdsOverviewRpcArgs", () => {
    it("builds the ids-only RPC payload with no sort but with pagination", () => {
        expect(
            buildProjectIdsOverviewRpcArgs({
                userId: "user-1",
                userEmail: " User@Example.com ",
                scope: "shared",
                searchTerm: "merger",
                practice: "Litigation",
                ownerUserId: "user-2",
                pagination: { limit: 1000, offset: 2000 },
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: "user@example.com",
            p_scope: "shared",
            p_search_term: "merger",
            p_practice: "Litigation",
            p_owner_user_id: "user-2",
            p_limit: 1000,
            p_offset: 2000,
        });
    });

    it("uses default scope and filter values when omitted", () => {
        expect(
            buildProjectIdsOverviewRpcArgs({
                userId: "user-1",
                userEmail: undefined,
                pagination: { limit: 1000, offset: 0 },
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: null,
            p_scope: "all",
            p_search_term: null,
            p_practice: null,
            p_owner_user_id: null,
            p_limit: 1000,
            p_offset: 0,
        });
    });
});

describe("parseProjectScope", () => {
    it("accepts supported project scopes", () => {
        expect(parseProjectScope("mine")).toBe("mine");
        expect(parseProjectScope("shared")).toBe("shared");
        expect(parseProjectScope("collaborative")).toBe("collaborative");
        expect(parseProjectScope("private")).toBe("private");
    });

    it("falls back to all for missing or unsupported scopes", () => {
        expect(parseProjectScope(undefined)).toBe("all");
        expect(parseProjectScope("in-project")).toBe("all");
    });
});
