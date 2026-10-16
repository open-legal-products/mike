/**
 * The Word add-in's support hand-off, exercised from the frontend test runner.
 *
 * Fail-without-fix: "Contact support" was a `mailto:` anchor in the toast and
 * in PaneErrorFallback. The add-in's own code says navigation out of the pane
 * is blocked in desktop Word (three separate `openBrowserWindow` helpers said
 * so), so that link did nothing there — and the request id the user needed
 * existed only inside the draft that never opened.
 *
 * The destination is the support mailbox, NOT the web app's /support form:
 * that form posts to a route the backend does not mount, so every submission
 * fails. These tests pin the address to the shared constant so the two can
 * never drift.
 */
import { describe, expect, it } from "vitest";
import {
    SUPPORT_DRAFT_AND_CLIPBOARD_MESSAGE,
    SUPPORT_DRAFT_MESSAGE,
    SUPPORT_EMAIL,
    buildSupportDiagnostics,
    supportHandoffResult,
    type SupportErrorFields,
} from "../../../word-addin/src/taskpane/lib/supportHandoff";

const WHEN = new Date("2026-09-17T10:20:30.000Z");

const SERVER_FAILURE: SupportErrorFields = {
    title: "Couldn't save the document",
    message: "Something went wrong on our side. Try again.",
    kind: "server",
    status: 500,
    code: "internal_error",
    requestId: "req-abc123",
};

describe("buildSupportDiagnostics", () => {
    it("carries everything support needs to find the failure in the logs", () => {
        expect(
            buildSupportDiagnostics(SERVER_FAILURE, {
                page: "Assistant",
                note: "Applying a tracked change.",
                product: "word-addin",
                when: WHEN,
                userAgent: "Word/16.89 (Macintosh)",
            }),
        ).toBe(
            [
                "Mike support details",
                "What happened: Couldn't save the document",
                "Message shown: Something went wrong on our side. Try again.",
                "Details: Applying a tracked change.",
                "Request ID: req-abc123",
                "Error code: internal_error",
                "HTTP status: 500",
                "Category: server",
                "Page: Assistant",
                "Client: word-addin",
                "Time: 2026-09-17T10:20:30.000Z",
                "Browser: Word/16.89 (Macintosh)",
            ].join("\n"),
        );
    });

    it("omits the lines it has nothing for", () => {
        const block = buildSupportDiagnostics(
            {
                title: "Connection problem",
                message: "Mike couldn't reach the server.",
                kind: "network",
                status: null,
                code: null,
                requestId: null,
            },
            { when: WHEN, userAgent: "" },
        );
        expect(block).toBe(
            [
                "Mike support details",
                "What happened: Connection problem",
                "Message shown: Mike couldn't reach the server.",
                "Category: network",
                "Time: 2026-09-17T10:20:30.000Z",
            ].join("\n"),
        );
        expect(block).not.toContain("Request ID");
        expect(block).not.toContain("HTTP status");
    });

    it("is pasteable as-is: plain lines, no URL encoding", () => {
        const block = buildSupportDiagnostics(SERVER_FAILURE, { when: WHEN });
        expect(block).not.toContain("%20");
        expect(block).not.toContain("mailto:");
    });
});

describe("supportHandoffResult", () => {
    const details = "Mike support details\nRequest ID: req-abc123";

    it("confirms both when the draft opened and the block was copied", () => {
        expect(
            supportHandoffResult({ copied: true, opened: true, details }),
        ).toEqual({
            tone: "success",
            message: SUPPORT_DRAFT_AND_CLIPBOARD_MESSAGE,
        });
        expect(SUPPORT_DRAFT_AND_CLIPBOARD_MESSAGE).toBe(
            "Email draft opened — the details are also on your clipboard",
        );
    });

    it("still confirms the draft when the clipboard was refused", () => {
        expect(
            supportHandoffResult({ copied: false, opened: true, details }),
        ).toEqual({ tone: "success", message: SUPPORT_DRAFT_MESSAGE });
        expect(SUPPORT_DRAFT_MESSAGE).toBe("Email draft opened");
    });

    it("names the mailbox when the host would not open the draft", () => {
        const result = supportHandoffResult({
            copied: true,
            opened: false,
            details,
        });
        expect(result).toEqual({
            tone: "info",
            message: `Email ${SUPPORT_EMAIL} — the details are on your clipboard`,
        });
        // The address comes from the shared constant, never a literal.
        expect(result.message).toContain("will@mikeoss.com");
        expect(result.details).toBeUndefined();
    });

    it("leaves no dead end when the host refuses both", () => {
        // Nothing worked, so the block goes on screen to copy by hand.
        expect(
            supportHandoffResult({ copied: false, opened: false, details }),
        ).toEqual({
            tone: "info",
            message: `Email ${SUPPORT_EMAIL}`,
            details,
        });
    });

    it("never sends the user to the web support form", () => {
        // That form posts to a route the backend does not mount.
        for (const copied of [true, false]) {
            for (const opened of [true, false]) {
                const result = supportHandoffResult({ copied, opened, details });
                expect(result.message).not.toContain("/support");
                expect(result.tone).not.toBe("error");
            }
        }
    });
});

it("does not put credentials or URL tokens on the clipboard", () => {
    const block = buildSupportDiagnostics(SERVER_FAILURE, {
        page: "https://user:password@word.example/taskpane.html?code=secret#access_token=hidden",
    });
    expect(block).toContain("Page: https://word.example/taskpane.html");
    expect(block).not.toMatch(/password|secret|hidden|user@/);
});
