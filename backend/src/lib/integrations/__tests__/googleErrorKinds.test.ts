// The Google integrations' fixed user-facing errors are AppErrors: the
// message stays for the user, the `kind` is what Sentry groups by, and
// Google's HTTP status (when the failure was its response) rides along.

import { describe, expect, it } from "vitest";
import { AppError } from "../../appError";
import { GoogleDriveUserError, googleDriveHttpError } from "../googleDriveHttp";
import { GoogleWorkspaceError } from "../googleWorkspaceAuth";
import { GoogleApiError } from "../googleWorkspaceApi";

describe("Google Drive error kinds", () => {
    it("names a rejected credential, a user-side refusal and a Google failure apart", () => {
        const rejected = googleDriveHttpError(401);
        expect(rejected).toBeInstanceOf(AppError);
        expect(rejected).toBeInstanceOf(GoogleDriveUserError);
        expect(rejected.kind).toBe("google.auth_failed");
        expect(rejected.status).toBe(401);

        expect(googleDriveHttpError(404).kind).toBe("google.user_error");
        expect(googleDriveHttpError(403).status).toBe(403);

        expect(googleDriveHttpError(429).kind).toBe("google.api_failed");
        const outage = googleDriveHttpError(503);
        expect(outage.kind).toBe("google.api_failed");
        expect(outage.status).toBe(503);
        expect(outage.message).toBe(
            "Google Drive could not complete the request. Please try again.",
        );
    });

    it("defaults a plain user error to google.user_error and keeps the cause", () => {
        const cause = new Error("decrypt failed");
        const plain = new GoogleDriveUserError("Google Drive is not connected.");
        expect(plain.kind).toBe("google.user_error");
        expect(plain.status).toBeUndefined();
        const wrapped = new GoogleDriveUserError("The outcome is uncertain.", {
            kind: "google.api_failed",
            cause,
        });
        expect(wrapped.kind).toBe("google.api_failed");
        expect(wrapped.cause).toBe(cause);
    });
});

describe("Google Workspace error kinds", () => {
    it("treats a Workspace error as a Google API failure unless told otherwise", () => {
        const generic = new GoogleWorkspaceError("Google did not answer.");
        expect(generic).toBeInstanceOf(AppError);
        expect(generic.kind).toBe("google.api_failed");
        expect(
            new GoogleWorkspaceError("Connect Gmail first.", { kind: "google.user_error" }).kind,
        ).toBe("google.user_error");
        expect(
            new GoogleWorkspaceError("Permissions missing.", { kind: "google.scope_missing" }).kind,
        ).toBe("google.scope_missing");
    });

    it("reads the kind of a Google API response off its status", () => {
        const unauthorised = new GoogleApiError("Gmail rejected the credential.", 401);
        expect(unauthorised).toBeInstanceOf(GoogleWorkspaceError);
        expect(unauthorised.kind).toBe("google.auth_failed");
        expect(unauthorised.status).toBe(401);
        expect(new GoogleApiError("Gmail is unavailable.", 503).kind).toBe("google.api_failed");
    });
});
