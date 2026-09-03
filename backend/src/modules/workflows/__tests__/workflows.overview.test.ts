import { describe, expect, it } from "vitest";
import {
    buildWorkflowIdsOverviewRpcArgs,
    buildWorkflowsOverviewRpcArgs,
    parseWorkflowScope,
} from "../workflows.overview";

describe("buildWorkflowsOverviewRpcArgs", () => {
    it("builds the full RPC payload when the paginated signature is requested", () => {
        expect(
            buildWorkflowsOverviewRpcArgs({
                userId: "user-1",
                userEmail: "user@example.com",
                type: "tabular",
                scope: "owned",
                pagination: { limit: 25, offset: 10 },
                searchTerm: "merger",
                sort: { key: "name", direction: "asc" },
                practice: "Litigation",
                language: "English",
                jurisdiction: "NSW",
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: "user@example.com",
            p_type: "tabular",
            p_scope: "owned",
            p_limit: 25,
            p_offset: 10,
            p_search_term: "merger",
            p_sort_key: "name",
            p_sort_direction: "asc",
            p_practice: "Litigation",
            p_language: "English",
            p_jurisdiction: "NSW",
        });
    });

    it("uses default pagination, sort, and filter values when omitted", () => {
        expect(
            buildWorkflowsOverviewRpcArgs({
                userId: "user-1",
                userEmail: undefined,
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: null,
            p_type: null,
            p_scope: "all",
            p_limit: 20,
            p_offset: 0,
            p_search_term: null,
            p_sort_key: "created",
            p_sort_direction: "desc",
            p_practice: null,
            p_language: null,
            p_jurisdiction: null,
        });
    });
});

describe("buildWorkflowIdsOverviewRpcArgs", () => {
    it("builds the ids-only RPC payload with no sort but with pagination", () => {
        expect(
            buildWorkflowIdsOverviewRpcArgs({
                userId: "user-1",
                userEmail: "user@example.com",
                type: "assistant",
                scope: "shared",
                searchTerm: "merger",
                practice: "Litigation",
                language: "English",
                jurisdiction: "NSW",
                pagination: { limit: 1000, offset: 2000 },
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: "user@example.com",
            p_type: "assistant",
            p_scope: "shared",
            p_search_term: "merger",
            p_practice: "Litigation",
            p_language: "English",
            p_jurisdiction: "NSW",
            p_limit: 1000,
            p_offset: 2000,
        });
    });

    it("uses default scope and filter values when omitted", () => {
        expect(
            buildWorkflowIdsOverviewRpcArgs({
                userId: "user-1",
                userEmail: undefined,
                pagination: { limit: 1000, offset: 0 },
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: null,
            p_type: null,
            p_scope: "all",
            p_search_term: null,
            p_practice: null,
            p_language: null,
            p_jurisdiction: null,
            p_limit: 1000,
            p_offset: 0,
        });
    });
});

describe("parseWorkflowScope", () => {
    it("accepts supported workflow scopes", () => {
        expect(parseWorkflowScope("owned")).toBe("owned");
        expect(parseWorkflowScope("shared")).toBe("shared");
    });

    it("falls back to all for missing or unsupported scopes", () => {
        expect(parseWorkflowScope(undefined)).toBe("all");
        expect(parseWorkflowScope("mine")).toBe("all");
    });
});
