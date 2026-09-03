import { describe, expect, it } from "vitest";
import {
    buildTabularReviewIdsOverviewRpcArgs,
    buildTabularReviewsOverviewRpcArgs,
    parseTabularReviewScope,
} from "../tabular.overview";

describe("buildTabularReviewsOverviewRpcArgs", () => {
    it("builds the full RPC payload when the paginated signature is requested", () => {
        expect(
            buildTabularReviewsOverviewRpcArgs({
                userId: "user-1",
                userEmail: "user@example.com",
                projectIdFilter: "project-1",
                scope: "in-project",
                pagination: { limit: 25, offset: 10 },
                searchTerm: "merger",
                sort: { key: "name", direction: "asc" },
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: "user@example.com",
            p_project_id: "project-1",
            p_scope: "in-project",
            p_limit: 25,
            p_offset: 10,
            p_search_term: "merger",
            p_sort_key: "name",
            p_sort_direction: "asc",
        });
    });

    it("uses default pagination and sort values when omitted", () => {
        expect(
            buildTabularReviewsOverviewRpcArgs({
                userId: "user-1",
                userEmail: undefined,
                projectIdFilter: null,
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: null,
            p_project_id: null,
            p_scope: "all",
            p_limit: 20,
            p_offset: 0,
            p_search_term: null,
            p_sort_key: "created",
            p_sort_direction: "desc",
        });
    });
});

describe("buildTabularReviewIdsOverviewRpcArgs", () => {
    it("builds the ids-only RPC payload with no sort but with pagination", () => {
        expect(
            buildTabularReviewIdsOverviewRpcArgs({
                userId: "user-1",
                userEmail: "user@example.com",
                projectIdFilter: "project-1",
                scope: "in-project",
                searchTerm: "merger",
                pagination: { limit: 1000, offset: 2000 },
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: "user@example.com",
            p_project_id: "project-1",
            p_scope: "in-project",
            p_search_term: "merger",
            p_limit: 1000,
            p_offset: 2000,
        });
    });

    it("uses default scope and search values when omitted", () => {
        expect(
            buildTabularReviewIdsOverviewRpcArgs({
                userId: "user-1",
                userEmail: undefined,
                projectIdFilter: null,
                pagination: { limit: 1000, offset: 0 },
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: null,
            p_project_id: null,
            p_scope: "all",
            p_search_term: null,
            p_limit: 1000,
            p_offset: 0,
        });
    });
});

describe("parseTabularReviewScope", () => {
    it("accepts supported review scopes", () => {
        expect(parseTabularReviewScope("in-project")).toBe("in-project");
        expect(parseTabularReviewScope("standalone")).toBe("standalone");
    });

    it("falls back to all for missing or unsupported scopes", () => {
        expect(parseTabularReviewScope(undefined)).toBe("all");
        expect(parseTabularReviewScope("shared")).toBe("all");
    });
});
