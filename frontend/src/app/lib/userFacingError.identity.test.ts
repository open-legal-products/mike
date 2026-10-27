import { afterEach, describe, expect, it, vi } from "vitest";
import { clearToasts, getSnapshot } from "@/shared/lib/toastStore";
import { MikeApiError, UploadBatchError } from "./mikeApi";
import { errorFrameFailure } from "./chatTurnFailure";
import {
    UserVisibleError,
    describeError,
    isOnAuthRoute,
    notifyError,
    notifyPartialFailure,
    reportFault,
    reportFlowFailure,
    uploadBatchFault,
    userFacingApiError,
} from "./userFacingError";

const reporting = vi.hoisted(() => ({
    reportError: vi.fn(),
    isReported: vi.fn(() => false),
}));
vi.mock("./errorReporting", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./errorReporting")>()),
    ...reporting,
}));

afterEach(() => {
    clearToasts();
    vi.clearAllMocks();
    reporting.isReported.mockReturnValue(false);
});

const tagsOfLastReport = () =>
    (reporting.reportError.mock.calls.at(-1)?.[1] as { tags: Record<string, unknown> }).tags;

describe("operation identity on reports", () => {
    it("reportFault reports an unknown fault under it, and keeps the message", () => {
        const described = reportFault(new Error("boom"), {
            action: "load the runs",
            operation: "playbooks.review",
        });

        expect(described.message).not.toContain("boom");
        expect(reporting.reportError).toHaveBeenCalledTimes(1);
        expect(tagsOfLastReport()).toMatchObject({
            component: "notify",
            operation: "playbooks.review",
        });
    });

    it("describeError without an operation stays a pure description", () => {
        describeError(new Error("boom"), { action: "load the runs" });
        expect(reporting.reportError).not.toHaveBeenCalled();
    });

    it("does not report a 4xx answer, a cancellation or a failure already reported", () => {
        reportFault(
            new MikeApiError({ status: 404, message: "gone" }),
            { operation: "documents.open" },
        );
        reportFault(new DOMException("Aborted", "AbortError"), {
            operation: "documents.open",
        });
        reporting.isReported.mockReturnValue(true);
        reportFault(new MikeApiError({ status: 500, message: "x" }), {
            operation: "documents.open",
        });

        expect(reporting.reportError).not.toHaveBeenCalled();
    });

    it("carries the server's code and request id next to the operation", () => {
        const error = new MikeApiError({
            status: 500,
            code: "internal_error",
            message: "x",
            requestId: "11111111-2222-4333-8444-555555555555",
        });

        reportFault(error, { operation: "settings.keys" });

        expect(tagsOfLastReport()).toMatchObject({
            operation: "settings.keys",
            error_code: "internal_error",
            request_id: "11111111-2222-4333-8444-555555555555",
        });
    });

    it("notifyError passes the operation through to the report", () => {
        notifyError(new Error("boom"), {
            action: "run this review",
            operation: "tabular.run",
        });

        expect(getSnapshot()).toHaveLength(1);
        expect(tagsOfLastReport()).toMatchObject({ operation: "tabular.run" });
    });

    it("userFacingApiError is pure and returns the fallback", () => {
        const message = userFacingApiError(new Error("boom"), "Unable to load assets.");

        expect(message).toBe("Unable to load assets.");
        expect(reporting.reportError).not.toHaveBeenCalled();
    });
});

describe("reportFlowFailure", () => {
    it("reports a 5xx read by hand with its route, status, code and request id", () => {
        reportFlowFailure({
            operation: "tabular.run",
            method: "POST",
            path: "/api/tabular-reviews/abc/run",
            status: 503,
            code: "upstream_unavailable",
            requestId: "11111111-2222-4333-8444-555555555555",
        });

        expect(tagsOfLastReport()).toMatchObject({
            component: "mike-api",
            operation: "tabular.run",
            http_method: "POST",
            http_route: "/api/tabular-reviews/abc/run",
            http_status: 503,
            error_code: "upstream_unavailable",
            request_id: "11111111-2222-4333-8444-555555555555",
        });
    });

    it("treats a 4xx as an answer, not a fault", () => {
        reportFlowFailure({ operation: "tabular.run", status: 409, code: "review_running" });
        expect(reporting.reportError).not.toHaveBeenCalled();
    });

    it("reports an SSE error frame (no status) with the frame's code", () => {
        reportFlowFailure({ operation: "tabular.run", code: "internal_error", requestId: null });
        expect(tagsOfLastReport()).toMatchObject({
            operation: "tabular.run",
            error_code: "internal_error",
        });
        expect(tagsOfLastReport().http_status).toBeUndefined();
    });

    it("marks the error it is handed so the toast does not file it twice", () => {
        const error = Object.assign(new Error("API error: 500"), { status: 500 });
        reportFlowFailure({ operation: "tabular.run", status: 500, error });
        expect(reporting.reportError).toHaveBeenCalledWith(error, expect.anything());
        reporting.isReported.mockReturnValue(true);
        notifyError(error, { action: "run this review", operation: "tabular.run" });
        expect(reporting.reportError).toHaveBeenCalledTimes(1);
    });
});

describe("notifyPartialFailure with an underlying cause", () => {
    it("stays a quiet conflict without a cause", () => {
        notifyPartialFailure("2 documents could not be moved.", {
            operation: "documents.directory",
        });

        expect(getSnapshot().at(-1)?.message).toBe("2 documents could not be moved.");
        expect(reporting.reportError).not.toHaveBeenCalled();
    });

    it("reports a cause that is our fault under the operation", () => {
        const cause = new UploadBatchError("x", []);
        notifyPartialFailure("a.pdf could not be uploaded.", {
            operation: "documents.upload",
            cause,
        });

        expect(reporting.reportError).toHaveBeenCalledWith(
            cause,
            expect.objectContaining({ tags: expect.objectContaining({ operation: "documents.upload" }) }),
        );
    });

    it("does not report a cause the user caused", () => {
        notifyPartialFailure("Too large.", {
            operation: "documents.upload",
            cause: new UserVisibleError("Too large.", { kind: "validation" }),
        });
        notifyPartialFailure("Changed elsewhere.", {
            operation: "documents.upload",
            cause: new MikeApiError({ status: 409, code: "upload_target_busy", message: "x" }),
        });

        expect(reporting.reportError).not.toHaveBeenCalled();
    });
});

describe("uploadBatchFault", () => {
    const outcome = (errorCode: string | null, status: "error" | "completed" = "error") => ({
        clientId: "c",
        filename: "a.pdf",
        status,
        result: null,
        errorCode,
    });

    it("is null when every failure is user-side or already reported per part", () => {
        expect(
            uploadBatchFault([
                outcome("upload_file_too_large"),
                outcome("direct_upload_failed"),
                outcome("document_changed"),
                outcome(null, "completed"),
            ]),
        ).toBeNull();
    });

    it("wraps the failures when one of them is ours", () => {
        const fault = uploadBatchFault([
            outcome("upload_file_too_large"),
            outcome("processing_failed"),
            outcome(null, "completed"),
        ]);

        expect(fault).toBeInstanceOf(UploadBatchError);
        expect(fault?.outcomes).toHaveLength(2);
    });
});

describe("which faults a notice reports", () => {
    it("treats a server render, with no window, as not on an auth route", () => {
        vi.stubGlobal("window", undefined);
        try {
            expect(isOnAuthRoute()).toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("leaves a stream error frame to the server's own event, but files an HTTP 5xx", () => {
        // A frame: server kind, a request id, no HTTP status. The backend
        // reported it with the stack; the toast is for the user.
        notifyError(errorFrameFailure("x", false, { code: "internal_error", requestId: "11111111-2222-4333-8444-555555555555" }), { action: "get a response" });
        expect(reporting.reportError).not.toHaveBeenCalled();
        // An HTTP 5xx keeps both halves, joined by the request id.
        notifyError(new MikeApiError({ status: 500, code: "internal_error", message: "x", requestId: "11111111-2222-4333-8444-555555555555" }), { action: "load documents" });
        expect(tagsOfLastReport()).toMatchObject({ component: "notify", error_code: "internal_error", request_id: "11111111-2222-4333-8444-555555555555" });
    });

    it("reads a snake_case request id off an unknown failure", () => {
        notifyError(Object.assign(new Error("boom"), { request_id: "11111111-2222-4333-8444-555555555555" }), { action: "save" });
        expect(tagsOfLastReport()).toMatchObject({ component: "notify", request_id: "11111111-2222-4333-8444-555555555555" });
    });

    it("does not file a flow failure the API client already reported, nor a frame the server filed", () => {
        reporting.isReported.mockReturnValue(true);
        reportFlowFailure({ operation: "tabular.run", status: 500, error: new Error("already sent") });
        expect(reporting.reportError).not.toHaveBeenCalled();
        reporting.isReported.mockReturnValue(false);
        reportFlowFailure({ operation: "tabular.run", code: "internal_error", requestId: "11111111-2222-4333-8444-555555555555" });
        expect(reporting.reportError).not.toHaveBeenCalled();
        reportFlowFailure({ operation: "tabular.run", code: "internal_error" });
        expect(tagsOfLastReport()).toMatchObject({ operation: "tabular.run", error_code: "internal_error" });
    });
});
