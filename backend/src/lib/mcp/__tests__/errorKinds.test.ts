import { describe, expect, it } from "vitest";
import { AppError, findAppError } from "../../appError";
import {
    BlockedDestinationError,
    isBlockedDestinationError,
} from "../../blockedDestination";
import { diagnosticErrorTags } from "../../observability/sentryPrivacy";
import { ConnectorSetupError } from "../errors";
import { McpOAuthRequiredError } from "../oauth";

// Each error our connector code throws names what went wrong as an AppError
// kind, so the privacy boundary tags it from the cause chain. The codes and
// names routes and callers already match on are unchanged.
describe("MCP error kinds", () => {
    it("ConnectorSetupError keeps its code and names mcp.setup_failed", () => {
        const error = new ConnectorSetupError("Connector needs a URL.");
        expect(error).toBeInstanceOf(AppError);
        expect(error.name).toBe("ConnectorSetupError");
        expect(error.code).toBe("connector_setup_required");
        expect(error.kind).toBe("mcp.setup_failed");
        expect(diagnosticErrorTags(error)).toMatchObject({ error_kind: "mcp.setup_failed" });
    });

    it("McpOAuthRequiredError keeps its code and defaults, and names mcp.oauth_required", () => {
        const error = new McpOAuthRequiredError();
        expect(error.name).toBe("McpOAuthRequiredError");
        expect(error.code).toBe("oauth_required");
        expect(error.permanent).toBe(true);
        expect(error.oauthErrorCode).toBeNull();
        expect(error.kind).toBe("mcp.oauth_required");
        const temporary = new McpOAuthRequiredError("Try again.", {
            permanent: false,
            oauthErrorCode: "temporarily_unavailable",
        });
        expect(temporary.permanent).toBe(false);
        expect(temporary.oauthErrorCode).toBe("temporarily_unavailable");
    });

    it("BlockedDestinationError keeps its code, its cause, and names mcp.blocked_destination", () => {
        const cause = new Error("resolved to 10.0.0.1");
        const error = new BlockedDestinationError("Blocked network address.", { cause });
        expect(error.name).toBe("BlockedDestinationError");
        expect(error.code).toBe("ERR_BLOCKED_DESTINATION");
        expect(error.cause).toBe(cause);
        expect(error.kind).toBe("mcp.blocked_destination");
        expect(isBlockedDestinationError(error)).toBe(true);
        // Found through a wrapper (undici's "fetch failed"), as callers see it.
        expect(findAppError(new TypeError("fetch failed", { cause: error }))).toBe(error);
    });
});
