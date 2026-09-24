import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { MikeApiError } from "./mikeApi";

// The Sentry SDK is not loaded in tests; what matters is which failures
// reach `reportError` and which do not.
const reported = vi.hoisted(() => ({
    reportError: vi.fn(),
    isReported: vi.fn(() => false),
}));
vi.mock("@/app/lib/errorReporting", () => ({
    reportError: reported.reportError,
    isReported: reported.isReported,
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
    setReportingUser: vi.fn(),
    scrubEvent: vi.fn(),
}));
import {
    errorCode,
    knownErrorCodeMessage,
    notifyError,
    notifyInfo,
    notifySuccess,
    supportMailtoFor,
    userFacingApiError,
} from "./userFacingError";

describe("userFacingApiError", () => {
    it("allows intentional client-error details", () => {
        const error = new MikeApiError({
            status: 400,
            message: "The filename is required.",
        });

        expect(userFacingApiError(error, "Fallback")).toBe(
            "The filename is required.",
        );
    });

    it("does not expose server or plain exception messages", () => {
        expect(
            userFacingApiError(
                new MikeApiError({
                    status: 500,
                    message: "relation user_profiles does not exist",
                }),
                "Please try again.",
            ),
        ).toBe("Please try again.");
        expect(
            userFacingApiError(
                new Error("getaddrinfo ENOTFOUND internal-db"),
                "Please try again.",
            ),
        ).toBe("Please try again.");
    });

    it("rejects non-client statuses and empty client-error messages", () => {
        expect(
            userFacingApiError(
                new MikeApiError({ status: 399, message: "Unexpected" }),
                "Fallback",
            ),
        ).toBe("Fallback");
        expect(
            userFacingApiError(
                new MikeApiError({ status: 400, message: "" }),
                "Fallback",
            ),
        ).toBe("Fallback");
    });
});

describe("errorCode", () => {
    it("returns null for values without a string code", () => {
        expect(errorCode(null)).toBeNull();
        expect(errorCode("invalid_credentials")).toBeNull();
        expect(errorCode({})).toBeNull();
        expect(errorCode({ code: 403 })).toBeNull();
    });
});

describe("knownErrorCodeMessage", () => {
    it("maps allowlisted codes and hides unknown ones", () => {
        const messages = { invalid_credentials: "Incorrect credentials." };
        expect(
            knownErrorCodeMessage(
                { code: "invalid_credentials" },
                messages,
                "Unable to log in.",
            ),
        ).toBe("Incorrect credentials.");
        expect(
            knownErrorCodeMessage(
                { code: "internal_provider_error" },
                messages,
                "Unable to log in.",
            ),
        ).toBe("Unable to log in.");
    });

    it("uses the fallback when no error code is available", () => {
        expect(
            knownErrorCodeMessage(
                new Error("provider failed"),
                { invalid_credentials: "Incorrect credentials." },
                "Unable to log in.",
            ),
        ).toBe("Unable to log in.");
    });
});

describe("notifyError", () => {
    beforeEach(() => {
        clearToasts();
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        clearToasts();
        vi.restoreAllMocks();
    });

    it("shows a toast with Retry and Contact support for a server failure", () => {
        render(<ToastViewportUI />);
        const onRetry = vi.fn();
        const result: { described: ReturnType<typeof notifyError> } = {
            described: null,
        };
        act(() => {
            result.described = notifyError(
                new MikeApiError({
                    status: 500,
                    message: "internal",
                    requestId: "req-9",
                }),
                { action: "save the document", onRetry },
            );
        });
        expect(result.described?.kind).toBe("server");
        const alert = screen.getByRole("alert");
        expect(alert).toHaveTextContent("Couldn't save the document");
        expect(alert).not.toHaveTextContent("internal");
        expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
        const support = screen.getByRole("link", { name: "Contact support" });
        expect(support.getAttribute("href")).toMatch(
            /^mailto:will@mikeoss\.com\?/,
        );
        expect(decodeURIComponent(support.getAttribute("href") ?? "")).toContain(
            "Request ID: req-9",
        );
    });

    it("puts everything support needs in the email, on every route", () => {
        // The in-app form at /support has no backend route to post to, so
        // the email draft is the hand-off — and it has to carry enough to
        // find the request in the logs without the user quoting a document.
        for (const pathname of ["/documents/1", "/login"]) {
            clearToasts();
            const original = window.location;
            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: {
                    ...original,
                    href: `https://app.test${pathname}`,
                    pathname,
                    search: "",
                },
            });
            try {
                const { unmount } = render(<ToastViewportUI />);
                act(() => {
                    notifyError(
                        new MikeApiError({
                            status: 500,
                            message: "internal",
                            code: "internal_error",
                            requestId: "req-9",
                        }),
                        {
                            action: "save the document",
                            supportNote: "While renaming Contract.docx",
                        },
                    );
                });
                const href = decodeURIComponent(
                    screen
                        .getByRole("link", { name: "Contact support" })
                        .getAttribute("href") ?? "",
                );
                expect(href.startsWith("mailto:will@mikeoss.com?")).toBe(true);
                expect(href).toContain("Request ID: req-9");
                expect(href).toContain("Error code: internal_error");
                expect(href).toContain("HTTP status: 500");
                expect(href).toContain(`Page: https://app.test${pathname}`);
                expect(href).toContain("Details: While renaming Contract.docx");
                // Support is a link, never an in-app action.
                expect(
                    screen.queryByRole("button", { name: "Contact support" }),
                ).toBeNull();
                unmount();
            } finally {
                Object.defineProperty(window, "location", {
                    configurable: true,
                    writable: true,
                    value: original,
                });
            }
        }
    });

    it("offers a way back to the login screen when the session is gone", () => {
        render(<ToastViewportUI />);
        const assign = vi.fn();
        const original = window.location;
        Object.defineProperty(window, "location", {
            configurable: true,
            writable: true,
            value: {
                ...original,
                pathname: "/documents/1",
                search: "?tab=edits",
                assign,
            },
        });
        try {
            act(() => {
                notifyError(new MikeApiError({ status: 401, message: "no" }));
            });
            act(() => {
                screen.getByRole("button", { name: "Sign in" }).click();
            });
            expect(assign).toHaveBeenCalledWith(
                "/login?next=%2Fdocuments%2F1%3Ftab%3Dedits",
            );
        } finally {
            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: original,
            });
        }
    });

    it("offers neither Retry nor support for a validation failure", () => {
        render(<ToastViewportUI />);
        act(() => {
            notifyError(
                new MikeApiError({
                    status: 400,
                    message: "Password must be at most 72 UTF-8 bytes. Accented characters and emoji can use more than one byte.",
                }),
                { onRetry: () => {} },
            );
        });
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Password must be at most 72 UTF-8 bytes. Accented characters and emoji can use more than one byte.",
        );
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
        expect(
            screen.queryByRole("link", { name: "Contact support" }),
        ).toBeNull();
    });

    it("stays silent for a cancellation", () => {
        render(<ToastViewportUI />);
        const result: { described: ReturnType<typeof notifyError> } = {
            described: undefined as unknown as null,
        };
        act(() => {
            result.described = notifyError(
                new DOMException("aborted", "AbortError"),
            );
        });
        expect(result.described).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("collapses repeated failures sharing a dedupe key", () => {
        render(<ToastViewportUI />);
        act(() => {
            notifyError(new TypeError("Failed to fetch"), { dedupeKey: "poll" });
            notifyError(new TypeError("Failed to fetch"), { dedupeKey: "poll" });
        });
        expect(screen.getAllByRole("alert")).toHaveLength(1);
    });

    it("notifySuccess shows a status toast", () => {
        render(<ToastViewportUI />);
        act(() => {
            notifySuccess("Saved");
        });
        expect(screen.getByRole("status")).toHaveTextContent("Saved");
    });
});

describe("notifyError options", () => {
    beforeEach(() => {
        clearToasts();
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        clearToasts();
        vi.restoreAllMocks();
    });

    it("honours support overrides and extra actions", () => {
        render(<ToastViewportUI />);
        const onOpen = vi.fn();
        act(() => {
            notifyError(new MikeApiError({ status: 500, message: "x" }), {
                support: false,
                actions: [{ label: "Open settings", onClick: onOpen }],
            });
            notifyError(
                new MikeApiError({ status: 400, message: "Bad input." }),
                { support: true, supportNote: "While renaming Contract.docx" },
            );
        });
        expect(
            screen.getByRole("button", { name: "Open settings" }),
        ).toBeVisible();
        const links = screen.getAllByRole("link", { name: "Contact support" });
        expect(links).toHaveLength(1);
        expect(decodeURIComponent(links[0].getAttribute("href") ?? "")).toContain(
            "Details: While renaming Contract.docx",
        );
    });

    it("notifyInfo shows a status toast with a title", () => {
        render(<ToastViewportUI />);
        act(() => {
            notifyInfo("Export started", "Heads up");
        });
        expect(screen.getByRole("status")).toHaveTextContent("Heads up");
        expect(screen.getByRole("status")).toHaveTextContent("Export started");
    });

    it("supportMailtoFor works without a window", () => {
        const win = globalThis.window;
        // @ts-expect-error simulate a non-browser runtime
        delete globalThis.window;
        try {
            const href = supportMailtoFor({
                kind: "server",
                title: "T",
                message: "M",
                retryable: true,
                supportable: true,
                status: 500,
                code: null,
                requestId: null,
                cause: null,
            });
            expect(href).not.toContain("Page:");
            expect(href).toContain("Client");
        } finally {
            globalThis.window = win;
        }
    });

    it("offers no Sign in action without a window to navigate", () => {
        const win = globalThis.window;
        // @ts-expect-error simulate a non-browser runtime
        delete globalThis.window;
        try {
            const described = notifyError(
                new MikeApiError({ status: 401, message: "no" }),
                { onRetry: () => undefined },
            );
            expect(described?.kind).toBe("unauthenticated");
        } finally {
            globalThis.window = win;
        }
        render(<ToastViewportUI />);
        expect(
            screen.queryByRole("button", { name: "Sign in" }),
        ).not.toBeInTheDocument();
    });

    it("keeps the diagnostic console line out of production", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.stubEnv("NODE_ENV", "production");
        try {
            notifyError(new MikeApiError({ status: 500, message: "boom" }));
            expect(warn).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
            warn.mockRestore();
        }
    });
});

describe("what notifyError reports to Sentry", () => {
    beforeEach(() => {
        clearToasts();
        reported.reportError.mockClear();
        reported.isReported.mockReturnValue(false);
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        clearToasts();
        vi.restoreAllMocks();
    });

    it("reports a throw it could not classify", () => {
        const bug = new Error("cannot read properties of undefined");
        act(() => {
            notifyError(bug, { action: "open the workflow" });
        });
        expect(reported.reportError).toHaveBeenCalledTimes(1);
        expect(reported.reportError).toHaveBeenCalledWith(bug, {
            tags: { component: "notify", action: "open the workflow" },
        });
    });

    it("reports a 5xx the API client did not already report, once", () => {
        act(() => {
            notifyError(new MikeApiError({ status: 500, message: "x" }));
        });
        expect(reported.reportError).toHaveBeenCalledTimes(1);
    });

    it("does not report a caught fault twice", () => {
        reported.isReported.mockReturnValue(true);
        act(() => { notifyError(new Error("already captured")); });
        expect(reported.reportError).not.toHaveBeenCalled();
    });

    it("does not report a 5xx twice", () => {
        reported.isReported.mockReturnValue(true);
        act(() => {
            notifyError(new MikeApiError({ status: 500, message: "x" }));
        });
        expect(reported.reportError).not.toHaveBeenCalled();
    });

    it("stays quiet for failures that are not faults", () => {
        act(() => {
            // An intentional 4xx answer.
            notifyError(new MikeApiError({ status: 400, message: "Bad." }));
            // The transport, already reported under component: mike-api.
            notifyError(new TypeError("Failed to fetch"));
            // A cancellation the user caused.
            notifyError(new DOMException("x", "AbortError"));
        });
        expect(reported.reportError).not.toHaveBeenCalled();
    });
});


describe("failed toast retries", () => {
    afterEach(() => clearToasts());

    it("reports a rejected retry and lets the user try again", async () => {
        clearToasts();
        render(<ToastViewportUI />);
        const onRetry = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockResolvedValueOnce(undefined);
        act(() => { notifyError(new TypeError("Failed to fetch"), {
            action: "load this document", onRetry,
        }); });
        await act(async () => { screen.getByRole("button", { name: "Retry" }).click(); });
        expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load this document");
        await act(async () => { screen.getByRole("button", { name: "Retry" }).click(); });
        expect(onRetry).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("alert")).toBeNull();
    });
});
